const {artifacts, web3, assert} = require("@nomiclabs/buidler");
const {expectRevert, time} = require("@openzeppelin/test-helpers");
const LinguoToken = artifacts.require("./LinguoToken.sol");
const Arbitrator = artifacts.require("./EnhancedAppealableArbitrator.sol");
const ERC20Mock = artifacts.require("./ERC20Mock.sol");

const randomInt = (max) => Math.ceil(Math.random() * max);

const expectThrow = (tx) => expectRevert.unspecified(tx);

const increaseTime = (duration) => {
  return time.increase(duration);
};

const latestTime = async () => {
  return Number(await time.latest());
};

describe("LinguoToken", function () {
  let governor;
  let requester;
  let translator;
  let challenger;
  let other;
  let fakeFactory;

  before(async function () {
    const accounts = await web3.eth.getAccounts();
    governor = accounts[0];
    requester = accounts[1];
    translator = accounts[2];
    challenger = accounts[3];
    other = accounts[4];
    fakeFactory = accounts[5];
  });

  const arbitrationFee = 1000;
  const arbitratorExtraData = "0x85";
  const appealTimeOut = 100;
  const reviewTimeout = 2400;
  const translationMultiplier = 1000;
  const sharedMultiplier = 5000;
  const winnerMultiplier = 3000;
  const loserMultiplier = 7000;
  const NOT_PAYABLE_VALUE = String((2n ** 256n - 2n) / 2n);
  const tokenBalance = 100000000;

  const taskMinPrice = 5000;
  const taskMaxPrice = 10000;
  const submissionTimeout = 3600;
  let arbitrator;
  let linguo;
  let token;
  let MULTIPLIER_DIVISOR;
  let taskTx;
  let currentTime;
  let secondsPassed;

  beforeEach("initialize the contract", async function () {
    arbitrator = await Arbitrator.new(arbitrationFee, governor, arbitratorExtraData, appealTimeOut, {from: governor});

    await arbitrator.changeArbitrator(arbitrator.address);

    token = await ERC20Mock.new(requester, tokenBalance, {from: governor});

    linguo = await LinguoToken.new(
      arbitrator.address,
      arbitratorExtraData,
      token.address, // WETH.
      fakeFactory, // uniswapFactory. Can't test the uniswap getters because of the old compiler, so set it random value.
      reviewTimeout,
      translationMultiplier,
      sharedMultiplier,
      winnerMultiplier,
      loserMultiplier,
      {from: governor}
    );

    await token.approve(linguo.address, 50000000, {
      from: requester,
    });

    MULTIPLIER_DIVISOR = Number(await linguo.MULTIPLIER_DIVISOR());
    currentTime = await latestTime();

    // Create the task using WETH token address, to test the simplest getPriceInETH scenario.
    taskTx = await linguo.createTask(
      currentTime + submissionTimeout,
      token.address,
      taskMinPrice,
      taskMaxPrice,
      "TestMetaEvidence",
      {
        from: requester,
      }
    );
    // Because of time fluctuation the timeout stored in the contract can deviate a little from the variable value.
    // So subtract small amount to prevent the time increase going out of timeout range.
    secondsPassed = randomInt(submissionTimeout - 5);
    await increaseTime(secondsPassed);
  });

  it("Should set the correct values in constructor", async () => {
    assert.equal(await linguo.arbitrator(), arbitrator.address);
    assert.equal(await linguo.arbitratorExtraData(), arbitratorExtraData);
    assert.equal(await linguo.WETH(), token.address);
    assert.equal(await linguo.uniswapFactory(), fakeFactory);
    assert.equal(await linguo.governor(), governor);
    assert.equal(await linguo.reviewTimeout(), reviewTimeout);
    assert.equal(await linguo.translationMultiplier(), translationMultiplier);
    assert.equal(await linguo.sharedStakeMultiplier(), sharedMultiplier);
    assert.equal(await linguo.winnerStakeMultiplier(), winnerMultiplier);
    assert.equal(await linguo.loserStakeMultiplier(), loserMultiplier);
  });

  it("Should set the correct values in a newly created task and fire an event", async () => {
    const task = await linguo.tasks(0);
    assert.equal(task[0], token.address, "The token address is not set up properly");

    // An error up to 0.1% is allowed because of time fluctuation
    assert(
      Math.abs(submissionTimeout - Number(task[1])) <= submissionTimeout / 1000,
      "The submissionTimeout is not set up properly"
    );
    assert.equal(Number(task[2]), taskMinPrice, "The min price is not set up properly");
    assert.equal(Number(task[3]), taskMaxPrice, "The max price is not set up properly");
    assert.equal(Number(task[4]), 0, "The task status is not set up properly");
    assert.equal(task[6], requester, "The requester is not set up properly");
    assert.equal(Number(task[7]), taskMaxPrice, "The requester deposit is not set up properly");

    assert.equal(taskTx.logs[0].event, "MetaEvidence", "The event has not been created");
    assert.equal(Number(taskTx.logs[0].args._metaEvidenceID), 0, "The event has wrong task ID");
    assert.equal(taskTx.logs[0].args._evidence, "TestMetaEvidence", "The event has wrong meta-evidence string");

    assert.equal(taskTx.logs[1].event, "TaskCreated", "The second event has not been created");
    assert.equal(Number(taskTx.logs[1].args._taskID), 0, "The second event has wrong task ID");
    assert.equal(taskTx.logs[1].args._requester, requester, "The second event has wrong requester address");
    assert.equal(taskTx.logs[1].args._token, token.address, "The second event has wrong token address");
  });

  it("Should not be possible for max price to be less than min price", async () => {
    currentTime = await latestTime();
    // Invert max and min price to make sure it throws.
    await expectThrow(
      linguo.createTask(
        currentTime + submissionTimeout,
        token.address,
        taskMaxPrice,
        taskMinPrice,
        "TestMetaEvidence",
        {
          from: requester,
        }
      )
    );

    // Also check the require for the deadline.
    await expectThrow(
      linguo.createTask(currentTime - 5, token.address, taskMinPrice, taskMaxPrice, "TestMetaEvidence", {
        from: requester,
      })
    );
  });

  it("Should return correct task price and assignment deposit value before submission timeout ended", async () => {
    const priceLinguo = await linguo.getTaskPrice(0);
    const price = Math.floor(taskMinPrice + ((taskMaxPrice - taskMinPrice) * secondsPassed) / submissionTimeout);
    // an error up to 1% is allowed because of time fluctuation
    assert(Math.abs(Number(priceLinguo) - price) <= price / 100, "Contract returns incorrect task price");

    const priceETH = Number(await linguo.getTaskPriceInETH(0));
    assert.equal(priceETH, Number(priceLinguo), "Contract returns incorrect price in ETH");

    const deposit = Math.floor(arbitrationFee + (priceETH * translationMultiplier) / MULTIPLIER_DIVISOR);
    const depositLinguo = await linguo.getDepositValue(0);
    assert(Math.abs(Number(depositLinguo) - deposit) <= deposit / 100, "Contract returns incorrect required deposit");
  });

  it("Should return correct task price and assignment deposit value after submission timeout ended", async () => {
    await increaseTime(submissionTimeout + 1);
    const priceLinguo = await linguo.getTaskPrice(0);
    assert.equal(Number(priceLinguo), 0, "Contract returns incorrect task price after submission timeout ended");

    const priceETH = await linguo.getTaskPriceInETH(0);
    assert.equal(Number(priceETH), 0, "Contract returns incorrect task price in ETH after submission timeout ended");

    const deposit = NOT_PAYABLE_VALUE;
    const depositLinguo = await linguo.getDepositValue(0);
    assert.equal(
      String(depositLinguo),
      deposit,
      "Contract returns incorrect required deposit after submission timeout ended"
    );
  });

  it("Should return correct task price and assignment deposit when status is not `created`", async () => {
    const requiredDeposit = Number(await linguo.getDepositValue(0));
    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1000,
    });

    const expectedTaskPrice = 0;
    const actualTaskPrice = await linguo.getTaskPrice(0);
    assert.equal(
      Number(actualTaskPrice),
      expectedTaskPrice,
      "Contract returns incorrect task price if status is not `created`"
    );

    const expectedDeposit = NOT_PAYABLE_VALUE;
    const actualDeposit = await linguo.getDepositValue(0);
    assert.equal(
      Number(actualDeposit),
      expectedDeposit,
      "Contract returns incorrect required deposit if status is not `created`"
    );

    const priceETH = await linguo.getTaskPriceInETH(0);
    assert.equal(Number(priceETH), 0, "Contract returns incorrect task price in ETH if status is not `created`");
  });

  it("Should not be possible to pay less than required deposit value", async () => {
    const requiredDeposit = Number(await linguo.getDepositValue(0));
    await expectThrow(
      linguo.assignTask(0, {
        from: translator,
        value: requiredDeposit - 1,
      })
    );
  });

  it("Should emit TaskAssigned event after assigning to the task", async () => {
    const requiredDeposit = Number(await linguo.getDepositValue(0));
    const assignTx = await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1000,
    });

    assert.equal(assignTx.logs[0].event, "TaskAssigned", "The TaskAssigned event was not emitted");
  });

  it("Should reimburse requester leftover token price after assigning the task and should set correct values", async () => {
    const oldBalance = await token.balanceOf(requester);

    const requiredDeposit = Number(await linguo.getDepositValue(0));

    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1000,
    });

    const newBalance = await token.balanceOf(requester);
    const taskInfo = await linguo.getTaskParties(0);
    const task = await linguo.tasks(0);
    assert.equal(
      Number(newBalance),
      Number(oldBalance) + taskMaxPrice - Number(task[7]),
      "The requester was not reimbursed correctly"
    );
    assert.equal(taskInfo[1], translator, "The translator was not set up properly");

    assert(
      Math.abs(Number(task[8]) - requiredDeposit) <= requiredDeposit / 100,
      "The translator deposit was not set up properly"
    );
  });

  it("Should not be possible to submit translation after submission timeout ended", async () => {
    const requiredDeposit = Number(await linguo.getDepositValue(0));
    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1000,
    });
    await increaseTime(submissionTimeout - secondsPassed + 1);
    await expectThrow(
      linguo.submitTranslation(0, "ipfs:/X", {
        from: translator,
      })
    );
  });

  it("Only an assigned translator should be allowed to submit translation to a task", async () => {
    const requiredDeposit = Number(await linguo.getDepositValue(0));
    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1000,
    });
    await expectThrow(
      linguo.submitTranslation(0, "ipfs:/X", {
        from: other,
      })
    );
  });

  it("Should fire an event after translation is submitted", async () => {
    const requiredDeposit = Number(await linguo.getDepositValue(0));
    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1000,
    });
    const submissionTx = await linguo.submitTranslation(0, "ipfs:/X", {
      from: translator,
    });
    assert.equal(submissionTx.logs[0].event, "TranslationSubmitted", "The event has not been created");
    assert.equal(Number(submissionTx.logs[0].args._taskID), 0, "The event has wrong task ID");
    assert.equal(submissionTx.logs[0].args._translator, translator, "The event has wrong translator address");
    assert.equal(
      submissionTx.logs[0].args._translatedText,
      "ipfs:/X",
      "The event has wrong link to the translated text"
    );
  });

  it("Should reimburse requester if no one picked the task before submission timeout ended", async () => {
    await increaseTime(submissionTimeout + 1);
    const reimburseTx = await linguo.reimburseRequester(0);
    const newTokenBalance = await token.balanceOf(requester);

    assert.equal(reimburseTx.logs[0].event, "TaskResolved", "TaskResolved event was not emitted");
    assert.equal(newTokenBalance, tokenBalance, "The requester should have an initial token balance");
    const task = await linguo.tasks(0);
    assert.equal(Number(task[7]), 0, "The price should be set to 0");
    assert.equal(Number(task[8]), 0, "Sum deposit should be set to 0");
  });

  it("Should reimburse requester if translator failed to submit translation before submission timeout ended", async () => {
    const requiredDeposit = Number(await linguo.getDepositValue(0));
    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1000,
    });
    await increaseTime(submissionTimeout + 1);
    const oldBalance = web3.utils.toBN(await web3.eth.getBalance(requester));
    const oldTokenBalance = await token.balanceOf(requester);
    let task = await linguo.tasks(0);
    await linguo.reimburseRequester(0);

    const newBalance = web3.utils.toBN(await web3.eth.getBalance(requester));
    const newTokenBalance = await token.balanceOf(requester);
    assert.equal(
      newBalance.toString(),
      oldBalance.add(task[8]).toString(),
      "The requester was not reimbursed correctly"
    );
    assert.equal(
      Number(newTokenBalance),
      Number(oldTokenBalance) + Number(task[7]), // This sum should give an initial balance value.
      "The requester should have an initial token balance"
    );

    task = await linguo.tasks(0);
    assert.equal(Number(task[7]), 0, "The price should be set to 0");
    assert.equal(Number(task[8]), 0, "Sum deposit should be set to 0");
  });

  it("Should not be possible to reimburse if submission timeout has not passed", async () => {
    await increaseTime(submissionTimeout - secondsPassed - 5);
    await expectThrow(linguo.reimburseRequester(0));
  });

  it("Should accept the translation and pay the translator if review timeout has passed without challenge", async () => {
    const requiredDeposit = Number(await linguo.getDepositValue(0));
    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1000,
    });
    await linguo.submitTranslation(0, "ipfs:/X", {from: translator});
    await increaseTime(reviewTimeout + 1);
    let task = await linguo.tasks(0);

    const oldBalance = web3.utils.toBN(await web3.eth.getBalance(translator));
    const acceptTx = await linguo.acceptTranslation(0);
    const newBalance = web3.utils.toBN(await web3.eth.getBalance(translator));
    const newTokenBalance = await token.balanceOf(translator);

    assert.equal(acceptTx.logs[0].event, "TaskResolved", "TaskResolved event was not emitted");

    assert.equal(
      newBalance.toString(),
      oldBalance.add(task[8]).toString(),
      "The translator did not get his deposit back"
    );
    assert.equal(
      Number(newTokenBalance),
      Number(task[7]), // Translator's initial token balance was 0, so now it should be equal to the task price.
      "The translator was not paid correctly"
    );
    task = await linguo.tasks(0);
    assert.equal(Number(task[7]), 0, "The price should be set to 0");
    assert.equal(Number(task[8]), 0, "Sum deposit should be set to 0");
  });

  it("Should not be possible to accept translation if review timeout has not passed or if it was challenged", async () => {
    const requiredDeposit = Number(await linguo.getDepositValue(0));

    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1000,
    });
    await linguo.submitTranslation(0, "ipfs:/X", {from: translator});
    await expectThrow(linguo.acceptTranslation(0));

    const challengerDeposit = arbitrationFee;
    await linguo.challengeTranslation(0, "", {
      from: challenger,
      value: challengerDeposit,
    });
    await increaseTime(reviewTimeout + 1);
    await expectThrow(linguo.acceptTranslation(0));
  });

  it("Should set correct values in contract and in dispute and emit TranslationChallenged event after task has been challenged", async () => {
    const requiredDeposit = Number(await linguo.getDepositValue(0));

    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1000,
    });
    await linguo.submitTranslation(0, "ipfs:/X", {from: translator});

    const challengerDeposit = arbitrationFee;

    // Check that reverts if the deposit is lower than expected
    await expectThrow(
      linguo.challengeTranslation(0, "ChallengeEvidence:/X", {
        from: challenger,
        value: challengerDeposit - 1,
      })
    );

    let task = await linguo.tasks(0);
    const expectedSumDeposit = challengerDeposit + Number(task[8]) - arbitrationFee;

    const challengeTx = await linguo.challengeTranslation(0, "ChallengeEvidence", {
      from: challenger,
      value: challengerDeposit,
    });

    assert.equal(challengeTx.logs[1].event, "TranslationChallenged", "TranslationChallenged event was not emitted");

    assert.equal(challengeTx.logs[2].event, "Evidence", "Evidence event was not emitted");

    assert.equal(challengeTx.logs[2].args._arbitrator, arbitrator.address, "The Evidence event has wrong arbitrator");

    assert.equal(Number(challengeTx.logs[2].args._evidenceGroupID), 0, "The Evidence event has wrong evidenceGroupID");

    assert.equal(challengeTx.logs[2].args._party, challenger, "The Evidence event has wrong party address");

    assert.equal(
      challengeTx.logs[2].args._evidence,
      "ChallengeEvidence",
      "The Evidence event has wrong evidence string"
    );

    task = await linguo.tasks(0);
    const taskInfo = await linguo.getTaskParties(0);
    assert.equal(taskInfo[2], challenger, "The challenger was not set up properly");

    assert.equal(
      Number(task[8]),
      expectedSumDeposit,
      "The sum of translator and challenger deposits was not set up properly"
    );

    const dispute = await arbitrator.disputes(0);
    assert.equal(dispute[0], linguo.address, "Arbitrable not set up properly");
    assert.equal(Number(dispute[1]), 2, "Number of choices not set up properly");
    assert.equal(Number(dispute[2]), 1000, "Arbitration fee not set up properly");
  });

  it("Should not allow to challenge if review timeout has passed", async () => {
    const requiredDeposit = Number(await linguo.getDepositValue(0));

    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1000,
    });
    await linguo.submitTranslation(0, "ipfs:/X", {from: translator});
    const challengerDeposit = arbitrationFee;
    await increaseTime(reviewTimeout + 1);
    await expectThrow(
      linguo.challengeTranslation(0, "", {
        from: challenger,
        value: challengerDeposit,
      })
    );
  });

  it("Should pay to all parties correctly when arbitrator refused to rule", async () => {
    const requiredDeposit = Number(await linguo.getDepositValue(0));

    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1000,
    });

    await linguo.submitTranslation(0, "ipfs:/X", {from: translator});

    const challengerDeposit = arbitrationFee;
    await linguo.challengeTranslation(0, "", {
      from: challenger,
      value: challengerDeposit,
    });

    let task = await linguo.tasks(0);
    const halfSumDeposit = Math.floor(Number(task[8]) / 2);

    const oldTokenBalanceRequester = await token.balanceOf(requester);

    const oldBalance1 = web3.utils.toBN(await web3.eth.getBalance(translator));
    const oldBalance2 = web3.utils.toBN(await web3.eth.getBalance(challenger));

    await arbitrator.giveRuling(0, 0);
    await increaseTime(appealTimeOut + 1);
    await arbitrator.giveRuling(0, 0);

    const newBalance1 = web3.utils.toBN(await web3.eth.getBalance(translator));
    const newBalance2 = web3.utils.toBN(await web3.eth.getBalance(challenger));

    const newTokenBalanceRequester = await token.balanceOf(requester);

    assert.equal(
      Number(newTokenBalanceRequester),
      Number(oldTokenBalanceRequester) + Number(task[7]),
      "The requester was not reimbursed correctly"
    );

    assert.equal(
      newBalance1.toString(),
      oldBalance1.add(web3.utils.toBN(halfSumDeposit)).toString(),
      "The translator was not paid correctly"
    );

    assert.equal(
      newBalance2.toString(),
      oldBalance2.add(web3.utils.toBN(halfSumDeposit)).toString(),
      "The challenger was not paid correctly"
    );

    task = await linguo.tasks(0);
    assert.equal(Number(task[10]), 0, "The ruling of the task is incorrect");
    assert.equal(Number(task[7]), 0, "The price should be set to 0");
    assert.equal(Number(task[8]), 0, "Sum deposit should be set to 0");
  });

  it("Should pay to all parties correctly if translator wins", async () => {
    const requiredDeposit = Number(await linguo.getDepositValue(0));

    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1000,
    });
    await linguo.submitTranslation(0, "ipfs:/X", {from: translator});

    const challengerDeposit = arbitrationFee;
    await linguo.challengeTranslation(0, "", {
      from: challenger,
      value: challengerDeposit,
    });

    let task = await linguo.tasks(0);

    const oldTokenBalanceRequester = await token.balanceOf(requester);
    const oldBalance1 = web3.utils.toBN(await web3.eth.getBalance(translator));
    const oldBalance2 = web3.utils.toBN(await web3.eth.getBalance(challenger));

    await arbitrator.giveRuling(0, 1);
    await increaseTime(appealTimeOut + 1);
    await arbitrator.giveRuling(0, 1);

    const newTokenBalanceRequester = await token.balanceOf(requester);
    const newBalance1 = web3.utils.toBN(await web3.eth.getBalance(translator));
    const newBalance2 = web3.utils.toBN(await web3.eth.getBalance(challenger));

    const balanceTokenTranslator = await token.balanceOf(translator);

    assert.equal(
      Number(newTokenBalanceRequester),
      Number(oldTokenBalanceRequester),
      "The requester should have the same token balance"
    );

    assert.equal(newBalance1.toString(), oldBalance1.add(task[8]).toString(), "The translator was not paid correctly");
    assert.equal(Number(balanceTokenTranslator), Number(task[7]), "The translator has incorrect token balance");

    assert.equal(newBalance2.toString(), oldBalance2.toString(), "The challenger should have the same balance");

    task = await linguo.tasks(0);
    assert.equal(Number(task[10]), 1, "The ruling of the task is incorrect");
  });

  it("Should pay to all parties correctly if challenger wins", async () => {
    const requiredDeposit = Number(await linguo.getDepositValue(0));

    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1000,
    });

    await linguo.submitTranslation(0, "ipfs:/X", {from: translator});

    const challengerDeposit = arbitrationFee;
    await linguo.challengeTranslation(0, "", {
      from: challenger,
      value: challengerDeposit,
    });

    let task = await linguo.tasks(0);

    const oldTokenBalanceRequester = await token.balanceOf(requester);
    const oldBalance1 = web3.utils.toBN(await web3.eth.getBalance(translator));
    const oldBalance2 = web3.utils.toBN(await web3.eth.getBalance(challenger));

    await arbitrator.giveRuling(0, 2);
    await increaseTime(appealTimeOut + 1);
    await arbitrator.giveRuling(0, 2);

    const newTokenBalanceRequester = await token.balanceOf(requester);
    const newBalance1 = web3.utils.toBN(await web3.eth.getBalance(translator));
    const newBalance2 = web3.utils.toBN(await web3.eth.getBalance(challenger));

    const balanceTokenTranslator = await token.balanceOf(translator);
    const balanceTokenChallenger = await token.balanceOf(challenger);

    assert.equal(
      Number(newTokenBalanceRequester),
      Number(oldTokenBalanceRequester) + Number(task[7]),
      "The requester was not reimbursed correctly"
    );

    assert.equal(newBalance1.toString(), oldBalance1.toString(), "The translator should have the same balance");
    assert.equal(Number(balanceTokenTranslator), 0, "The translator should have 0 token balance");

    assert.equal(newBalance2.toString(), oldBalance2.add(task[8]).toString(), "The challenger was not paid correctly");
    assert.equal(Number(balanceTokenChallenger), 0, "The challenger should have 0 token balance");

    task = await linguo.tasks(0);
    assert.equal(Number(task[10]), 2, "The ruling of the task is incorrect");
  });

  it("Should not be possible to assign the task after the timeout", async () => {
    const requiredDeposit = Number(await linguo.getDepositValue(0));
    await increaseTime(submissionTimeout - secondsPassed + 1);
    await expectThrow(
      linguo.assignTask(0, {
        from: translator,
        value: requiredDeposit + 1000,
      })
    );
  });

  it("Should demand correct appeal fees and register that appeal fee has been paid", async () => {
    let roundInfo;
    const requiredDeposit = Number(await linguo.getDepositValue(0));

    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1000,
    });
    await linguo.submitTranslation(0, "ipfs:/X", {from: translator});

    const challengerDeposit = arbitrationFee;
    await linguo.challengeTranslation(0, "", {
      from: challenger,
      value: challengerDeposit,
    });

    await arbitrator.giveRuling(0, 2);
    const loserAppealFee = arbitrationFee + (arbitrationFee * loserMultiplier) / MULTIPLIER_DIVISOR; // 1700

    const fundTx = await linguo.fundAppeal(0, 1, {
      from: translator,
      value: 10000, // Deliberately overpay to check that only required fee amount will be registered.
    });

    // Check that event is emitted when fees are paid.
    assert.equal(fundTx.logs[1].event, "HasPaidAppealFee", "The event has not been created");
    assert.equal(Number(fundTx.logs[1].args._taskID), 0, "The event has wrong task ID");
    assert.equal(Number(fundTx.logs[1].args._party), 1, "The event has wrong party");

    roundInfo = await linguo.getRoundInfo(0, 0);

    assert.equal(Number(roundInfo[0][1]), 1700, "Registered fee of translator is incorrect");
    assert.equal(roundInfo[1][1], true, "Did not register that translator successfully paid his fees");

    assert.equal(Number(roundInfo[0][2]), 0, "Should not register any payments for challenger");
    assert.equal(roundInfo[1][2], false, "Should not register that challenger successfully paid fees");

    // Check that it's not possible to fund appeal after funding has been registered.
    await expectThrow(linguo.fundAppeal(0, 1, {from: translator, value: loserAppealFee}));

    // increase time to make sure winner can pay in 2nd half
    await increaseTime(appealTimeOut / 2 + 1);
    await linguo.fundAppeal(0, 2, {
      from: challenger,
      value: 20000, // Deliberately overpay to check that only required fee amount will be registered.
    });

    roundInfo = await linguo.getRoundInfo(0, 0);

    assert.equal(Number(roundInfo[0][2]), 1300, "Registered fee of challenger is incorrect");
    assert.equal(roundInfo[1][2], true, "Did not register that challenger successfully paid his fees");

    assert.equal(
      Number(roundInfo[2]),
      2000, // winnerAppealFee + loserAppealFee - arbitrationFee
      "Incorrect fee rewards value"
    );

    // If both sides pay their fees it starts new appeal round. Check that both sides have their value set to default.
    roundInfo = await linguo.getRoundInfo(0, 1);
    assert.equal(roundInfo[1][1], false, "Appeal fee payment for translator should not be registered");
    assert.equal(roundInfo[1][2], false, "Appeal fee payment for challenger should not be registered");
  });

  it("Should change the ruling if loser paid appeal fee while winner did not", async () => {
    let task;
    const requiredDeposit = Number(await linguo.getDepositValue(0));

    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1000,
    });
    await linguo.submitTranslation(0, "ipfs:/X", {from: translator});

    const challengerDeposit = arbitrationFee;
    await linguo.challengeTranslation(0, "", {
      from: challenger,
      value: challengerDeposit,
    });

    task = await linguo.tasks(0);

    await arbitrator.giveRuling(0, 2);

    const loserAppealFee = arbitrationFee + (arbitrationFee * loserMultiplier) / MULTIPLIER_DIVISOR;
    await linguo.fundAppeal(0, 1, {
      from: translator,
      value: loserAppealFee,
    });
    await increaseTime(appealTimeOut + 1);

    const oldTokenBalanceRequester = await token.balanceOf(requester);
    const oldBalance1 = web3.utils.toBN(await web3.eth.getBalance(translator));
    const oldBalance2 = web3.utils.toBN(await web3.eth.getBalance(challenger));

    await arbitrator.giveRuling(0, 2);

    const newTokenBalanceRequester = await token.balanceOf(requester);
    const newBalance1 = web3.utils.toBN(await web3.eth.getBalance(translator));
    const newBalance2 = web3.utils.toBN(await web3.eth.getBalance(challenger));

    const balanceTokenTranslator = await token.balanceOf(translator);

    assert.equal(
      Number(newTokenBalanceRequester),
      Number(oldTokenBalanceRequester),
      "The requester should have the same token balance"
    );

    assert.equal(newBalance1.toString(), oldBalance1.add(task[8]).toString(), "The translator was not paid correctly");
    assert.equal(Number(balanceTokenTranslator), Number(task[7]), "The translator has incorrect token balance");

    assert.equal(newBalance2.toString(), oldBalance2.toString(), "The challenger should have the same balance");

    task = await linguo.tasks(0);
    assert.equal(Number(task[10]), 1, "The ruling of the task is incorrect");
  });

  it("Should withdraw correct fees", async () => {
    const requiredDeposit = Number(await linguo.getDepositValue(0));

    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1000,
    });
    await linguo.submitTranslation(0, "ipfs:/X", {from: translator});

    const challengerDeposit = arbitrationFee;
    await linguo.challengeTranslation(0, "", {
      from: challenger,
      value: challengerDeposit,
    });

    await arbitrator.giveRuling(0, 2);

    const loserAppealFee = arbitrationFee + (arbitrationFee * loserMultiplier) / MULTIPLIER_DIVISOR; // 1700

    await linguo.fundAppeal(0, 1, {
      from: other,
      value: web3.utils.toBN(Math.floor(loserAppealFee * 0.75)), // 1275
    });

    await linguo.fundAppeal(0, 1, {
      from: translator,
      value: 5000,
    });

    const winnerAppealFee = arbitrationFee + (arbitrationFee * winnerMultiplier) / MULTIPLIER_DIVISOR; // 1300

    await linguo.fundAppeal(0, 2, {
      from: other,
      value: web3.utils.toBN(Math.floor(0.2 * winnerAppealFee)), // 260
    });

    await linguo.fundAppeal(0, 2, {
      from: challenger,
      value: winnerAppealFee,
    });

    const roundInfo = await linguo.getRoundInfo(0, 0);

    await arbitrator.giveRuling(1, 2);

    await linguo.fundAppeal(0, 1, {
      from: translator,
      value: loserAppealFee - 1, // Deliberately underpay to check that in can be reimbursed later. (1699)
    });

    await increaseTime(appealTimeOut + 1);
    await arbitrator.giveRuling(1, 2);

    const oldBalance1 = web3.utils.toBN(await web3.eth.getBalance(translator));
    await linguo.withdrawFeesAndRewards(translator, 0, 0, {
      from: governor,
    });
    let newBalance1 = web3.utils.toBN(await web3.eth.getBalance(translator));
    assert.equal(
      newBalance1.toString(),
      oldBalance1.toString(),
      "Translator balance should stay the same after withdrawing from 0 round"
    );
    await linguo.withdrawFeesAndRewards(translator, 0, 1, {
      from: governor,
    });
    newBalance1 = web3.utils.toBN(await web3.eth.getBalance(translator));
    assert.equal(
      newBalance1.toString(),
      oldBalance1.add(web3.utils.toBN("1699")).toString(),
      "Translator should be reimbursed unsuccessful payment"
    );

    const oldBalance2 = web3.utils.toBN(await web3.eth.getBalance(challenger));
    await linguo.withdrawFeesAndRewards(challenger, 0, 0, {
      from: governor,
    });
    const newBalance2 = web3.utils.toBN(await web3.eth.getBalance(challenger));
    assert.equal(
      newBalance2.toString(),
      oldBalance2.add(web3.utils.toBN(Math.floor(0.8 * roundInfo[2]))).toString(), // 1600
      "Incorrect balance of the challenger after withdrawing"
    );

    const oldBalance3 = web3.utils.toBN(await web3.eth.getBalance(other));
    await linguo.withdrawFeesAndRewards(other, 0, 0, {
      from: governor,
    });
    const newBalance3 = web3.utils.toBN(await web3.eth.getBalance(other));
    assert.equal(
      newBalance3.toString(),
      oldBalance3.add(web3.utils.toBN(Math.floor(0.2 * roundInfo[2]))).toString(), // 400
      "Incorrect balance of the crowdfunder after withdrawing"
    );
  });

  it("Should make governance changes", async () => {
    // reviewTimeout
    await expectThrow(
      linguo.changeReviewTimeout(22, {
        from: other,
      })
    );
    await linguo.changeReviewTimeout(22, {
      from: governor,
    });

    assert.equal(Number(await linguo.reviewTimeout()), 22, "Incorrect review timeout value");
    // translationMultiplier
    await expectThrow(
      linguo.changeTranslationMultiplier(44, {
        from: other,
      })
    );
    await linguo.changeTranslationMultiplier(44, {
      from: governor,
    });

    assert.equal(Number(await linguo.translationMultiplier()), 44, "Incorrect translationMultiplier value");
    // shared multiplier
    await expectThrow(
      linguo.changeSharedStakeMultiplier(5011, {
        from: other,
      })
    );
    await linguo.changeSharedStakeMultiplier(5011, {
      from: governor,
    });

    assert.equal(Number(await linguo.sharedStakeMultiplier()), 5011, "Incorrect sharedStakeMultiplier value");
    // winner multiplier
    await expectThrow(
      linguo.changeWinnerStakeMultiplier(3033, {
        from: other,
      })
    );
    await linguo.changeWinnerStakeMultiplier(3033, {
      from: governor,
    });

    assert.equal(Number(await linguo.winnerStakeMultiplier()), 3033, "Incorrect winnerStakeMultiplier value");
    // governor
    await expectThrow(
      linguo.changeGovernor(other, {
        from: other,
      })
    );
    await linguo.changeGovernor(other, {
      from: governor,
    });

    assert.equal(await linguo.governor(), other, "Incorrect governor address");
    // loser multiplier
    await expectThrow(
      linguo.changeLoserStakeMultiplier(7077, {
        from: governor,
      })
    );
    await linguo.changeLoserStakeMultiplier(7077, {
      from: other,
    });

    assert.equal(Number(await linguo.loserStakeMultiplier()), 7077, "Incorrect loserStakeMultiplier value");
  });
});
