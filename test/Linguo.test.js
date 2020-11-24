const {artifacts, web3, assert} = require("@nomiclabs/buidler");
const {expectRevert, time} = require("@openzeppelin/test-helpers");
const Linguo = artifacts.require("./Linguo.sol");
const Arbitrator = artifacts.require("./EnhancedAppealableArbitrator.sol");

const randomInt = (max) => Math.ceil(Math.random() * max);

const expectThrow = (tx) => expectRevert.unspecified(tx);

const increaseTime = (duration) => {
  return time.increase(duration);
};

const latestTime = async () => {
  return Number(await time.latest());
};

describe("Linguo", function () {
  let governor;
  let requester;
  let translator;
  let challenger;
  let other;

  before(async function () {
    const accounts = await web3.eth.getAccounts();
    governor = accounts[0];
    requester = accounts[1];
    translator = accounts[2];
    challenger = accounts[3];
    other = accounts[4];
  });

  const arbitrationFee = 1e12;
  const arbitratorExtraData = "0x85";
  const appealTimeOut = 100;
  const reviewTimeout = 2400;
  const arbitrationCostMultiplier = 15000;
  const translationMultiplier = 2500;
  const challengeMultiplier = 2000;
  const sharedMultiplier = 5000;
  const winnerMultiplier = 3000;
  const loserMultiplier = 7000;
  const NOT_PAYABLE_VALUE = String((2n ** 256n - 2n) / 2n);

  const taskMinPrice = 1e12;
  const taskMaxPrice = 5e12;
  const submissionTimeout = 3600;
  let arbitrator;
  let linguo;
  let MULTIPLIER_DIVISOR;
  let taskTx;
  let submissionTx;
  let currentTime;
  let secondsPassed;

  beforeEach("initialize the contract", async function () {
    arbitrator = await Arbitrator.new(arbitrationFee, governor, arbitratorExtraData, appealTimeOut, {from: governor});

    await arbitrator.changeArbitrator(arbitrator.address);

    linguo = await Linguo.new(
      arbitrator.address,
      arbitratorExtraData,
      reviewTimeout,
      arbitrationCostMultiplier,
      translationMultiplier,
      challengeMultiplier,
      sharedMultiplier,
      winnerMultiplier,
      loserMultiplier,
      {from: governor}
    );

    MULTIPLIER_DIVISOR = (await linguo.MULTIPLIER_DIVISOR()).toNumber();
    currentTime = await latestTime();
    taskTx = await linguo.createTask(currentTime + submissionTimeout, String(taskMinPrice), "TestMetaEvidence", {
      from: requester,
      value: String(taskMaxPrice),
    });
    // Because of time fluctuation the timeout stored in the contract can deviate a little from the variable value.
    // So subtract small amount to prevent the time increase going out of timeout range.
    secondsPassed = randomInt(submissionTimeout - 5);
    await increaseTime(secondsPassed);
  });

  it("Should set the correct values in constructor", async () => {
    assert.equal(await linguo.arbitrator(), arbitrator.address);
    assert.equal(await linguo.arbitratorExtraData(), arbitratorExtraData);
    assert.equal(await linguo.reviewTimeout(), reviewTimeout);
    assert.equal(await linguo.translationMultiplier(), translationMultiplier);
    assert.equal(await linguo.challengeMultiplier(), challengeMultiplier);
    assert.equal(await linguo.sharedStakeMultiplier(), sharedMultiplier);
    assert.equal(await linguo.winnerStakeMultiplier(), winnerMultiplier);
    assert.equal(await linguo.loserStakeMultiplier(), loserMultiplier);
  });

  it("Should set the correct values in newly created task and fire an event", async () => {
    const task = await linguo.tasks(0);
    // An error up to 0.1% is allowed because of time fluctuation
    assert(
      Math.abs(submissionTimeout - task[0].toNumber()) <= submissionTimeout / 1000,
      "The submissionTimeout is not set up properly"
    );
    assert.equal(task[1].toNumber(), taskMinPrice, "The min price is not set up properly");
    assert.equal(task[2].toNumber(), taskMaxPrice, "The max price is not set up properly");

    assert.equal(task[3].toNumber(), 0, "The task status is not set up properly");
    assert.equal(task[5], requester, "The requester is not set up properly");
    assert.equal(task[6].toNumber(), taskMaxPrice, "The requester deposit is not set up properly");

    assert.equal(taskTx.logs[0].event, "MetaEvidence", "The event has not been created");
    assert.equal(taskTx.logs[0].args._metaEvidenceID.toNumber(), 0, "The event has wrong task ID");
    assert.equal(taskTx.logs[0].args._evidence, "TestMetaEvidence", "The event has wrong meta-evidence string");

    assert.equal(taskTx.logs[1].event, "TaskCreated", "The second event has not been created");
    assert.equal(taskTx.logs[1].args._taskID.toNumber(), 0, "The second event has wrong task ID");
    assert.equal(taskTx.logs[1].args._requester, requester, "The second event has wrong requester address");
  });

  it("Should not be possible to deposit less than min price when creating a task", async () => {
    currentTime = await latestTime();
    // Invert max and min price to make sure it throws when less than min price is deposited.
    await expectThrow(
      linguo.createTask(currentTime + submissionTimeout, taskMaxPrice, "TestMetaEvidence", {
        from: requester,
        value: taskMinPrice,
      })
    );
  });

  it("Should return correct task price and assignment deposit value before submission timeout ended", async () => {
    const priceLinguo = Number(await linguo.getTaskPrice(0));
    let price = Math.floor(taskMinPrice + ((taskMaxPrice - taskMinPrice) * secondsPassed) / submissionTimeout);
    // an error up to 1% is allowed because of time fluctuation
    assert(Math.abs(priceLinguo - price) <= price / 100, "Contract returns incorrect task price");

    price = Math.floor(taskMinPrice + ((taskMaxPrice - taskMinPrice) * secondsPassed) / submissionTimeout);
    const deposit = (arbitrationFee * arbitrationCostMultiplier + translationMultiplier * price) / MULTIPLIER_DIVISOR;
    const depositLinguo = await linguo.getDepositValue(0);

    assert(
      Math.abs(depositLinguo.toNumber() - deposit) <= deposit / 100,
      "Contract returns incorrect required deposit"
    );
  });

  it("Should return correct task price and assignment deposit value after submission timeout ended", async () => {
    await increaseTime(submissionTimeout + 1);
    const priceLinguo = Number(await linguo.getTaskPrice(0));
    assert.equal(priceLinguo, 0, "Contract returns incorrect task price after submission timeout ended");
    const deposit = String(NOT_PAYABLE_VALUE);
    const depositLinguo = String(await linguo.getDepositValue(0));
    assert.equal(depositLinguo, deposit, "Contract returns incorrect required deposit after submission timeout ended");
  });

  it("Should return correct task price and assignment deposit when status is not `created`", async () => {
    const requiredDeposit = Number(await linguo.getDepositValue(0));
    await linguo.assignTask(0, {
      from: translator,
      value: String(requiredDeposit + 1e11),
    });

    const expectedTaskPrice = 0;
    const actualTaskPrice = await linguo.getTaskPrice(0);
    assert.equal(
      actualTaskPrice,
      expectedTaskPrice,
      "Contract returns incorrect task price if status is not `created`"
    );

    const expectedDeposit = String(NOT_PAYABLE_VALUE);
    const actualDeposit = String(await linguo.getDepositValue(0));
    assert.equal(
      actualDeposit,
      expectedDeposit,
      "Contract returns incorrect required deposit if status is not `created`"
    );
  });

  it("Should not be possible to pay less than required deposit value", async () => {
    const requiredDeposit = Number(await linguo.getDepositValue(0));
    await expectThrow(
      linguo.assignTask(0, {
        from: translator,
        value: String(requiredDeposit - 1000),
      })
    );
  });

  it("Should emit TaskAssigned event after assigning to the task", async () => {
    const requiredDeposit = Number(await linguo.getDepositValue(0));
    const assignTx = await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1e11,
    });

    assert.equal(assignTx.logs[0].event, "TaskAssigned", "The TaskAssigned event was not emitted");
  });

  it("Should reimburse requester leftover price after assigning the task and set correct values", async () => {
    const oldBalance = web3.utils.toBN(await web3.eth.getBalance(requester));

    const requiredDeposit = Number(await linguo.getDepositValue(0));

    // Add a surplus of 0.1 ETH to the required deposit to account for the difference between the time transaction was created and mined.

    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1e11,
    });

    const newBalance = web3.utils.toBN(await web3.eth.getBalance(requester));
    const taskInfo = await linguo.getTaskParties(0);
    const task = await linguo.tasks(0);

    assert(
      newBalance.eq(oldBalance.add(web3.utils.toBN(taskMaxPrice)).sub(task[6])),
      "The requester was not reimbursed correctly"
    );
    assert.equal(taskInfo[1], translator, "The translator was not set up properly");
    // an error up to 1% is allowed because of time fluctuation
    assert(
      Math.abs(task[7].toNumber() - requiredDeposit) <= requiredDeposit / 100,
      "The translator deposit was not set up properly"
    );
  });

  it("Should not be possible to submit translation after submission timeout ended", async () => {
    const requiredDeposit = (await linguo.getDepositValue(0)).toNumber();
    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1e11,
    });
    await increaseTime(submissionTimeout - secondsPassed + 1);
    await expectThrow(
      linguo.submitTranslation(0, "ipfs:/X", {
        from: translator,
      })
    );
  });

  it("Only an assigned translator should be allowed to submit translation to a task", async () => {
    const requiredDeposit = (await linguo.getDepositValue(0)).toNumber();
    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1e11,
    });
    await expectThrow(
      linguo.submitTranslation(0, "ipfs:/X", {
        from: other,
      })
    );
  });

  it("Should fire an event after translation is submitted", async () => {
    const requiredDeposit = (await linguo.getDepositValue(0)).toNumber();
    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1e11,
    });
    submissionTx = await linguo.submitTranslation(0, "ipfs:/X", {
      from: translator,
    });
    assert.equal(submissionTx.logs[0].event, "TranslationSubmitted", "The event has not been created");
    assert.equal(submissionTx.logs[0].args._taskID.toNumber(), 0, "The event has wrong task ID");
    assert.equal(submissionTx.logs[0].args._translator, translator, "The event has wrong translator address");
    assert.equal(
      submissionTx.logs[0].args._translatedText,
      "ipfs:/X",
      "The event has wrong link to the translated text"
    );
  });

  it("Should reimburse requester if no one picked the task before submission timeout ended", async () => {
    await increaseTime(submissionTimeout + 1);
    const oldBalance = web3.utils.toBN(await web3.eth.getBalance(requester));
    const reimburseTx = await linguo.reimburseRequester(0);
    const newBalance = web3.utils.toBN(await web3.eth.getBalance(requester));

    assert.equal(reimburseTx.logs[0].event, "TaskResolved", "TaskResolved event was not emitted");
    assert.equal(
      newBalance.toString(),
      oldBalance.add(web3.utils.toBN(String(taskMaxPrice))).toString(),
      "The requester was not reimbursed correctly"
    );
  });

  it("Should reimburse requester if translator failed to submit translation before submission timeout ended", async () => {
    const requiredDeposit = (await linguo.getDepositValue(0)).toNumber();
    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1e11,
    });
    await increaseTime(submissionTimeout + 1);
    const oldBalance = web3.utils.toBN(await web3.eth.getBalance(requester));
    const task = await linguo.tasks(0);
    await linguo.reimburseRequester(0);
    const newBalance = web3.utils.toBN(await web3.eth.getBalance(requester));
    // task price + translator's deposit should go to requester
    assert.equal(
      newBalance.toString(),
      oldBalance.add(task[6]).add(task[7]).toString(),
      "The requester was not reimbursed correctly"
    );
  });

  it("Should not be possible to reimburse if submission timeout has not passed", async () => {
    await increaseTime(submissionTimeout - secondsPassed - 100);
    await expectThrow(linguo.reimburseRequester(0));
  });

  it("Should accept the translation and pay the translator if review timeout has passed without challenge", async () => {
    const requiredDeposit = (await linguo.getDepositValue(0)).toNumber();
    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1e11,
    });
    await linguo.submitTranslation(0, "ipfs:/X", {from: translator});
    await increaseTime(reviewTimeout + 1);
    const task = await linguo.tasks(0);

    const oldBalance = web3.utils.toBN(await web3.eth.getBalance(translator));
    const acceptTx = await linguo.acceptTranslation(0);
    const newBalance = web3.utils.toBN(await web3.eth.getBalance(translator));

    assert.equal(acceptTx.logs[0].event, "TaskResolved", "TaskResolved event was not emitted");

    assert.equal(
      newBalance.toString(),
      oldBalance.add(task[6]).add(task[7]).toString(),
      "The translator was not paid correctly"
    );
  });

  it("Should not be possible to accept translation if review timeout has not passed or if it was challenged", async () => {
    const requiredDeposit = (await linguo.getDepositValue(0)).toNumber();

    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1e11,
    });
    await linguo.submitTranslation(0, "ipfs:/X", {from: translator});
    await expectThrow(linguo.acceptTranslation(0));

    // add a small amount because javascript can have small deviations up to several hundreds when operating with large numbers
    const challengerDeposit = (await linguo.getChallengeValue(0)).toNumber() + 1000;
    await linguo.challengeTranslation(0, "", {
      from: challenger,
      value: challengerDeposit,
    });
    await increaseTime(reviewTimeout + 1);
    await expectThrow(linguo.acceptTranslation(0));
  });

  it("Should set correct values in contract and in dispute and emit TranslationChallenged event after task has been challenged", async () => {
    let task;
    const requiredDeposit = (await linguo.getDepositValue(0)).toNumber();

    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1e11,
    });
    await linguo.submitTranslation(0, "ipfs:/X", {from: translator});

    task = await linguo.tasks(0);
    // add a small amount because javascript can have small deviations up to several hundreds when operating with large numbers
    const challengerDeposit = (await linguo.getChallengeValue(0)).toNumber() + 1000;
    const challengeTx = await linguo.challengeTranslation(0, "ChallengeEvidence", {
      from: challenger,
      value: challengerDeposit,
    });

    assert.equal(challengeTx.logs[1].event, "TranslationChallenged", "TranslationChallenged event was not emitted");

    assert.equal(challengeTx.logs[2].event, "Evidence", "Evidence event was not emitted");

    assert.equal(challengeTx.logs[2].args._arbitrator, arbitrator.address, "The Evidence event has wrong arbitrator");

    assert.equal(
      challengeTx.logs[2].args._evidenceGroupID.toNumber(),
      0,
      "The Evidence event has wrong evidenceGroupID"
    );

    assert.equal(challengeTx.logs[2].args._party, challenger, "The Evidence event has wrong party address");

    assert.equal(
      challengeTx.logs[2].args._evidence,
      "ChallengeEvidence",
      "The Evidence event has wrong evidence string"
    );

    // get task info again because of updated values
    task = await linguo.tasks(0);
    const taskInfo = await linguo.getTaskParties(0);
    assert.equal(taskInfo[2], challenger, "The challenger was not set up properly");

    const sumDeposit = requiredDeposit + challengerDeposit - arbitrationFee - 1000;
    // an error up to 0.1% is allowed
    assert(
      Math.abs(task[7].toNumber() - sumDeposit) <= sumDeposit / 1000,
      "The sum of translator and challenger deposits was not set up properly"
    );

    const dispute = await arbitrator.disputes(0);
    assert.equal(dispute[0], linguo.address, "Arbitrable not set up properly");
    assert.equal(dispute[1].toNumber(), 2, "Number of choices not set up properly");
    assert.equal(dispute[2].toNumber(), 1e12, "Arbitration fee not set up properly");
  });

  it("Should not allow to challenge if review timeout has passed", async () => {
    const requiredDeposit = (await linguo.getDepositValue(0)).toNumber();

    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1e11,
    });
    await linguo.submitTranslation(0, "ipfs:/X", {from: translator});

    await increaseTime(reviewTimeout + 1);
    const task = await linguo.tasks(0);
    const price = task[6].toNumber();
    // add a small amount because javascript can have small deviations up to several hundreds when operating with large numbers
    const challengerDeposit = Math.floor(arbitrationFee + (challengeMultiplier * price) / MULTIPLIER_DIVISOR + 1000);
    await expectThrow(
      linguo.challengeTranslation(0, "", {
        from: challenger,
        value: challengerDeposit,
      })
    );
  });

  it("Should paid to all parties correctly when arbitrator refused to rule", async () => {
    let task;
    const requiredDeposit = (await linguo.getDepositValue(0)).toNumber();

    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1e11,
    });
    await linguo.submitTranslation(0, "ipfs:/X", {from: translator});

    task = await linguo.tasks(0);
    // add a small amount because javascript can have small deviations up to several hundreds when operating with large numbers
    const challengerDeposit = (await linguo.getChallengeValue(0)).toNumber() + 1000;
    await linguo.challengeTranslation(0, "", {
      from: challenger,
      value: challengerDeposit,
    });

    // Get the task info again to get updated sumDeposit value.
    task = await linguo.tasks(0);

    const oldBalance1 = web3.utils.toBN(await web3.eth.getBalance(requester));
    const oldBalance2 = web3.utils.toBN(await web3.eth.getBalance(translator));
    const oldBalance3 = web3.utils.toBN(await web3.eth.getBalance(challenger));

    await arbitrator.giveRuling(0, 0);
    await increaseTime(appealTimeOut + 1);
    await arbitrator.giveRuling(0, 0);

    const newBalance1 = web3.utils.toBN(await web3.eth.getBalance(requester));
    const newBalance2 = web3.utils.toBN(await web3.eth.getBalance(translator));
    const newBalance3 = web3.utils.toBN(await web3.eth.getBalance(challenger));

    assert.equal(newBalance1.toString(), oldBalance1.add(task[6]).toString(), "The requester was not paid correctly");
    // Check in proximity because division by 2 can sometimes return floating point which is not supported by solidity thus requiring conversion toNumber() which can have small aberration.
    const balance2 = Number(oldBalance2.add(task[7].div(web3.utils.toBN(2))));
    assert(
      Math.abs(balance2 - Number(newBalance2)) <= Number(newBalance2) / 10000,
      "The translator was not paid correctly"
    );

    const balance3 = Number(oldBalance3.add(task[7].div(web3.utils.toBN(2))));
    assert(
      Math.abs(balance3 - Number(newBalance3)) <= Number(newBalance3) / 10000,
      "The challenger was not paid correctly"
    );

    task = await linguo.tasks(0);
    assert.equal(Number(task[9]), 0, "The ruling of the task is incorrect");
  });

  it("Should paid to all parties correctly if translator wins", async () => {
    let task;
    const requiredDeposit = (await linguo.getDepositValue(0)).toNumber();

    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1e11,
    });
    await linguo.submitTranslation(0, "ipfs:/X", {from: translator});

    // add a small amount because javascript can have small deviations up to several hundreds when operating with large numbers
    const challengerDeposit = (await linguo.getChallengeValue(0)).toNumber() + 1000;
    await linguo.challengeTranslation(0, "", {
      from: challenger,
      value: challengerDeposit,
    });

    // Get the task info again to get updated sumDeposit value.
    task = await linguo.tasks(0);

    const oldBalance1 = web3.utils.toBN(await web3.eth.getBalance(requester));
    const oldBalance2 = web3.utils.toBN(await web3.eth.getBalance(translator));
    const oldBalance3 = web3.utils.toBN(await web3.eth.getBalance(challenger));

    await arbitrator.giveRuling(0, 1);
    await increaseTime(appealTimeOut + 1);
    await arbitrator.giveRuling(0, 1);

    const newBalance1 = web3.utils.toBN(await web3.eth.getBalance(requester));
    const newBalance2 = web3.utils.toBN(await web3.eth.getBalance(translator));
    const newBalance3 = web3.utils.toBN(await web3.eth.getBalance(challenger));

    assert.equal(newBalance1.toString(), oldBalance1.toString(), "Requester has incorrect balance");
    assert.equal(
      newBalance2.toString(),
      oldBalance2.add(task[6]).add(task[7]).toString(),
      "The translator was not paid correctly"
    );
    assert.equal(newBalance3.toString(), oldBalance3.toString(), "Challenger has incorrect balance");

    task = await linguo.tasks(0);
    assert.equal(task[9].toNumber(), 1, "The ruling of the task is incorrect");
  });

  it("Should paid to all parties correctly if challenger wins", async () => {
    let task;
    const requiredDeposit = (await linguo.getDepositValue(0)).toNumber();

    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1e11,
    });
    await linguo.submitTranslation(0, "ipfs:/X", {from: translator});

    task = await linguo.tasks(0);
    // add a small amount because javascript can have small deviations up to several hundreds when operating with large numbers
    const challengerDeposit = (await linguo.getChallengeValue(0)).toNumber() + 1000;
    await linguo.challengeTranslation(0, "", {
      from: challenger,
      value: challengerDeposit,
    });

    // Get the task info again to get updated sumDeposit value.
    task = await linguo.tasks(0);

    const oldBalance1 = web3.utils.toBN(await web3.eth.getBalance(requester));
    const oldBalance2 = web3.utils.toBN(await web3.eth.getBalance(translator));
    const oldBalance3 = web3.utils.toBN(await web3.eth.getBalance(challenger));

    await arbitrator.giveRuling(0, 2);
    await increaseTime(appealTimeOut + 1);
    await arbitrator.giveRuling(0, 2);

    const newBalance1 = web3.utils.toBN(await web3.eth.getBalance(requester));
    const newBalance2 = web3.utils.toBN(await web3.eth.getBalance(translator));
    const newBalance3 = web3.utils.toBN(await web3.eth.getBalance(challenger));

    assert.equal(newBalance1.toString(), oldBalance1.add(task[6]).toString(), "The requester was not paid correctly");
    assert.equal(newBalance2.toString(), oldBalance2.toString(), "Translator has incorrect balance");
    assert.equal(newBalance3.toString(), oldBalance3.add(task[7]).toString(), "The challenger was not paid correctly");

    task = await linguo.tasks(0);
    assert.equal(task[9].toNumber(), 2, "The ruling of the task is incorrect");
  });

  it("Should demand correct appeal fees and register that appeal fee has been paid", async () => {
    let roundInfo;
    const requiredDeposit = (await linguo.getDepositValue(0)).toNumber();

    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1e11,
    });
    await linguo.submitTranslation(0, "ipfs:/X", {from: translator});

    // add a small amount because javascript can have small deviations up to several hundreds when operating with large numbers
    const challengerDeposit = (await linguo.getChallengeValue(0)).toNumber() + 1000;
    await linguo.challengeTranslation(0, "", {
      from: challenger,
      value: challengerDeposit,
    });
    // in  that case translator is loser and challenger is winner
    await arbitrator.giveRuling(0, 2);
    // appeal fee is the same as arbitration fee for this arbitrator
    const loserAppealFee = arbitrationFee + (arbitrationFee * loserMultiplier) / MULTIPLIER_DIVISOR;

    const fundTx = await linguo.fundAppeal(0, 1, {
      from: translator,
      value: 3e12, // Deliberately overpay to check that only required fee amount will be registered.
    });

    // Check that event is emitted when fees are paid.
    assert.equal(fundTx.logs[1].event, "HasPaidAppealFee", "The event has not been created");
    assert.equal(fundTx.logs[1].args._taskID.toNumber(), 0, "The event has wrong task ID");
    assert.equal(fundTx.logs[1].args._party.toNumber(), 1, "The event has wrong party");

    roundInfo = await linguo.getRoundInfo(0, 0);

    assert.equal(roundInfo[0][1].toNumber(), loserAppealFee, "Registered fee of translator is incorrect");
    assert.equal(roundInfo[1][1], true, "Did not register that translator successfully paid his fees");

    assert.equal(roundInfo[0][2].toNumber(), 0, "Should not register any payments for challenger");
    assert.equal(roundInfo[1][2], false, "Should not register that challenger successfully paid fees");

    // Check that it's not possible to fund appeal after funding has been registered.
    await expectThrow(linguo.fundAppeal(0, 1, {from: translator, value: loserAppealFee}));

    const winnerAppealFee = arbitrationFee + (arbitrationFee * winnerMultiplier) / MULTIPLIER_DIVISOR;

    // increase time to make sure winner can pay in 2nd half
    await increaseTime(appealTimeOut / 2 + 1);
    await linguo.fundAppeal(0, 2, {
      from: challenger,
      value: 3e12, // Deliberately overpay to check that only required fee amount will be registered.
    });

    roundInfo = await linguo.getRoundInfo(0, 0);

    assert.equal(roundInfo[0][2].toNumber(), winnerAppealFee, "Registered fee of challenger is incorrect");
    assert.equal(roundInfo[1][2], true, "Did not register that challenger successfully paid his fees");

    assert.equal(
      roundInfo[2].toNumber(),
      winnerAppealFee + loserAppealFee - arbitrationFee,
      "Incorrect fee rewards value"
    );

    // If both sides pay their fees it starts new appeal round. Check that both sides have their value set to default.
    roundInfo = await linguo.getRoundInfo(0, 1);
    assert.equal(roundInfo[1][1], false, "Appeal fee payment for translator should not be registered");
    assert.equal(roundInfo[1][2], false, "Appeal fee payment for challenger should not be registered");
  });

  it("Should not be possible for loser to fund appeal if first half of appeal period has passed", async () => {
    const requiredDeposit = (await linguo.getDepositValue(0)).toNumber();

    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1e11,
    });
    await linguo.submitTranslation(0, "ipfs:/X", {from: translator});

    // DEL: const task = await linguo.tasks(0)
    // add a small amount because javascript can have small deviations up to several hundreds when operating with large numbers
    const challengerDeposit = (await linguo.getChallengeValue(0)).toNumber() + 1000;
    await linguo.challengeTranslation(0, "", {
      from: challenger,
      value: challengerDeposit,
    });
    await arbitrator.giveRuling(0, 1);
    const loserAppealFee = arbitrationFee + (arbitrationFee * loserMultiplier) / MULTIPLIER_DIVISOR;
    await increaseTime(appealTimeOut / 2 + 1);
    await expectThrow(linguo.fundAppeal(0, 2, {from: challenger, value: loserAppealFee}));
  });

  it("Should not be possible for winner to fund appeal if appeal period has passed", async () => {
    const requiredDeposit = (await linguo.getDepositValue(0)).toNumber();

    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1e11,
    });
    await linguo.submitTranslation(0, "ipfs:/X", {from: translator});

    // DEL: const task = await linguo.tasks(0)
    // add a small amount because javascript can have small deviations up to several hundreds when operating with large numbers
    const challengerDeposit = (await linguo.getChallengeValue(0)).toNumber() + 1000;
    await linguo.challengeTranslation(0, "", {
      from: challenger,
      value: challengerDeposit,
    });
    await arbitrator.giveRuling(0, 1);

    const winnerAppealFee = arbitrationFee + (arbitrationFee * winnerMultiplier) / MULTIPLIER_DIVISOR;
    await increaseTime(appealTimeOut + 1);
    await expectThrow(linguo.fundAppeal(0, 1, {from: translator, value: winnerAppealFee}));
  });

  it("Should change the ruling if loser paid appeal fee while winner did not", async () => {
    let task;
    const requiredDeposit = (await linguo.getDepositValue(0)).toNumber();

    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1e11,
    });
    await linguo.submitTranslation(0, "ipfs:/X", {from: translator});

    task = await linguo.tasks(0);
    // add a small amount because javascript can have small deviations up to several hundreds when operating with large numbers
    const challengerDeposit = (await linguo.getChallengeValue(0)).toNumber() + 1000;
    await linguo.challengeTranslation(0, "", {
      from: challenger,
      value: challengerDeposit,
    });
    // Get the task info again to get updated sumDeposit value.
    task = await linguo.tasks(0);

    await arbitrator.giveRuling(0, 2);

    const loserAppealFee = arbitrationFee + (arbitrationFee * loserMultiplier) / MULTIPLIER_DIVISOR;
    await linguo.fundAppeal(0, 1, {
      from: translator,
      value: loserAppealFee,
    });
    await increaseTime(appealTimeOut + 1);

    const oldBalance1 = web3.utils.toBN(await web3.eth.getBalance(requester));
    const oldBalance2 = web3.utils.toBN(await web3.eth.getBalance(translator));
    const oldBalance3 = web3.utils.toBN(await web3.eth.getBalance(challenger));

    await arbitrator.giveRuling(0, 2);

    const newBalance1 = web3.utils.toBN(await web3.eth.getBalance(requester));
    const newBalance2 = web3.utils.toBN(await web3.eth.getBalance(translator));
    const newBalance3 = web3.utils.toBN(await web3.eth.getBalance(challenger));

    // translator's balance should increase while other's stay the same despite ruling being in favor of challenger
    assert.equal(newBalance1.toString(), oldBalance1.toString(), "Requester has incorrect balance");
    assert.equal(
      newBalance2.toString(),
      oldBalance2.add(task[6]).add(task[7]).toString(),
      "The translator was not paid correctly"
    );
    assert.equal(newBalance3.toString(), oldBalance3.toString(), "Challenger has incorrect balance");

    task = await linguo.tasks(0);
    assert.equal(task[9].toNumber(), 1, "The ruling of the task is incorrect");
  });

  it("Should withdraw correct fees if dispute had winner/loser", async () => {
    const requiredDeposit = (await linguo.getDepositValue(0)).toNumber();

    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1e11,
    });
    await linguo.submitTranslation(0, "ipfs:/X", {from: translator});

    // DEL: const task = await linguo.tasks(0)

    // add a small amount because javascript can have small deviations up to several hundreds when operating with large numbers
    const challengerDeposit = (await linguo.getChallengeValue(0)).toNumber() + 1000;
    await linguo.challengeTranslation(0, "", {
      from: challenger,
      value: challengerDeposit,
    });

    await arbitrator.giveRuling(0, 2);

    const loserAppealFee = arbitrationFee + (arbitrationFee * loserMultiplier) / MULTIPLIER_DIVISOR;

    await linguo.fundAppeal(0, 1, {
      from: other,
      value: loserAppealFee * 0.75,
    });

    await linguo.fundAppeal(0, 1, {
      from: translator,
      value: 2e12,
    });

    const winnerAppealFee = arbitrationFee + (arbitrationFee * winnerMultiplier) / MULTIPLIER_DIVISOR;

    await linguo.fundAppeal(0, 2, {
      from: other,
      value: 0.2 * winnerAppealFee,
    });

    await linguo.fundAppeal(0, 2, {
      from: challenger,
      value: winnerAppealFee,
    });

    const roundInfo = await linguo.getRoundInfo(0, 0);

    await arbitrator.giveRuling(1, 2);

    await linguo.fundAppeal(0, 1, {
      from: translator,
      value: 1e11, // Deliberately underpay to check that in can be reimbursed later.
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
      oldBalance1.add(web3.utils.toBN(1e11)).toString(),
      "Translator should be reimbursed unsuccessful payment"
    );

    const oldBalance2 = web3.utils.toBN(await web3.eth.getBalance(challenger));
    await linguo.withdrawFeesAndRewards(challenger, 0, 0, {
      from: governor,
    });
    const newBalance2 = web3.utils.toBN(await web3.eth.getBalance(challenger));
    assert.equal(
      newBalance2.toString(),
      oldBalance2.add(web3.utils.toBN(Math.floor(0.8 * roundInfo[2]))).toString(),
      "Incorrect balance of the challenger after withdrawing"
    );

    const oldBalance3 = web3.utils.toBN(await web3.eth.getBalance(other));
    await linguo.withdrawFeesAndRewards(other, 0, 0, {
      from: governor,
    });
    const newBalance3 = web3.utils.toBN(await web3.eth.getBalance(other));
    assert.equal(
      newBalance3.toString(),
      oldBalance3.add(web3.utils.toBN(Math.floor(0.2 * roundInfo[2]))).toString(),
      "Incorrect balance of the crowdfunder after withdrawing"
    );
  });

  it("Should withdraw correct fees if arbitrator refused to arbitrate", async () => {
    const requiredDeposit = (await linguo.getDepositValue(0)).toNumber();

    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1e11,
    });
    await linguo.submitTranslation(0, "ipfs:/X", {from: translator});

    // DEL: const task = await linguo.tasks(0)
    // add a small amount because javascript can have small deviations up to several hundreds when operating with large numbers
    const challengerDeposit = (await linguo.getChallengeValue(0)).toNumber() + 1000;
    await linguo.challengeTranslation(0, "", {
      from: challenger,
      value: challengerDeposit,
    });

    await arbitrator.giveRuling(0, 0);

    const sharedAppealFee = arbitrationFee + (arbitrationFee * sharedMultiplier) / MULTIPLIER_DIVISOR;

    await linguo.fundAppeal(0, 1, {
      from: other,
      value: 0.4 * sharedAppealFee,
    });

    await linguo.fundAppeal(0, 1, {
      from: translator,
      value: 2e12,
    });

    await linguo.fundAppeal(0, 2, {
      from: other,
      value: 0.2 * sharedAppealFee,
    });

    await linguo.fundAppeal(0, 2, {
      from: challenger,
      value: sharedAppealFee,
    });

    const roundInfo = await linguo.getRoundInfo(0, 0);

    await arbitrator.giveRuling(1, 0);
    await increaseTime(appealTimeOut + 1);
    await arbitrator.giveRuling(1, 0);

    const oldBalance1 = web3.utils.toBN(await web3.eth.getBalance(translator));
    await linguo.withdrawFeesAndRewards(translator, 0, 0, {
      from: governor,
    });
    const newBalance1 = web3.utils.toBN(await web3.eth.getBalance(translator));
    assert.equal(
      newBalance1.toString(),
      oldBalance1.add(web3.utils.toBN(Math.floor(0.3 * roundInfo[2]))).toString(),
      "Incorrect translator balance after withdrawing"
    );

    const oldBalance2 = web3.utils.toBN(await web3.eth.getBalance(challenger));
    await linguo.withdrawFeesAndRewards(challenger, 0, 0, {
      from: governor,
    });
    const newBalance2 = web3.utils.toBN(await web3.eth.getBalance(challenger));
    assert.equal(
      newBalance2.toString(),
      oldBalance2.add(web3.utils.toBN(Math.floor(0.4 * roundInfo[2]))).toString(),
      "Incorrect balance of the challenger after withdrawing"
    );

    const oldBalance3 = web3.utils.toBN(await web3.eth.getBalance(other));
    await linguo.withdrawFeesAndRewards(other, 0, 0, {
      from: governor,
    });
    const newBalance3 = web3.utils.toBN(await web3.eth.getBalance(other));
    assert.equal(
      newBalance3.toString(),
      oldBalance3.add(web3.utils.toBN(Math.floor(0.3 * roundInfo[2]))).toString(),
      "Incorrect balance of the crowdfunder after withdrawing"
    );
  });

  it("Should correctly perform batch withdraw", async () => {
    const requiredDeposit = (await linguo.getDepositValue(0)).toNumber();

    await linguo.assignTask(0, {
      from: translator,
      value: requiredDeposit + 1e11,
    });
    await linguo.submitTranslation(0, "ipfs:/X", {from: translator});

    // DEL: const task = await linguo.tasks(0)
    // add a small amount because javascript can have small deviations up to several hundreds when operating with large numbers
    const challengerDeposit = (await linguo.getChallengeValue(0)).toNumber() + 1000;
    await linguo.challengeTranslation(0, "", {
      from: challenger,
      value: challengerDeposit,
    });

    await arbitrator.giveRuling(0, 1);

    const loserAppealFee = arbitrationFee + (arbitrationFee * loserMultiplier) / MULTIPLIER_DIVISOR;

    await linguo.fundAppeal(0, 2, {
      from: challenger,
      value: loserAppealFee,
    });

    const winnerAppealFee = arbitrationFee + (arbitrationFee * winnerMultiplier) / MULTIPLIER_DIVISOR;

    await linguo.fundAppeal(0, 1, {
      from: translator,
      value: winnerAppealFee,
    });
    const roundInfo = await linguo.getRoundInfo(0, 0);

    await arbitrator.giveRuling(1, 1);

    await linguo.fundAppeal(0, 2, {
      from: challenger,
      value: loserAppealFee,
    });

    await linguo.fundAppeal(0, 1, {
      from: translator,
      value: winnerAppealFee,
    });

    await arbitrator.giveRuling(2, 1);

    await linguo.fundAppeal(0, 2, {
      from: challenger,
      value: 0.5 * loserAppealFee,
    });

    await linguo.fundAppeal(0, 1, {
      from: translator,
      value: 0.5 * winnerAppealFee,
    });

    await increaseTime(appealTimeOut + 1);
    await arbitrator.giveRuling(2, 1);

    const amountTranslator = await linguo.amountWithdrawable(0, translator);
    const amountChallenger = await linguo.amountWithdrawable(0, challenger);

    const oldBalanceTranslator = web3.utils.toBN(await web3.eth.getBalance(translator));
    await linguo.batchRoundWithdraw(translator, 0, 1, 12, {
      from: governor,
    });
    const newBalanceTranslator1 = web3.utils.toBN(await web3.eth.getBalance(translator));
    assert.equal(
      newBalanceTranslator1.toString(),
      oldBalanceTranslator
        .add(web3.utils.toBN(Math.floor(roundInfo[2])))
        .add(web3.utils.toBN(Math.floor(0.5 * winnerAppealFee)))
        .toString(), // The last round was only paid half of the required amount.
      "Incorrect translator balance after withdrawing from last 2 rounds"
    );
    await linguo.batchRoundWithdraw(translator, 0, 0, 1, {
      from: governor,
    });

    const newBalanceTranslator2 = web3.utils.toBN(await web3.eth.getBalance(translator));
    assert.equal(
      newBalanceTranslator2.toString(),
      newBalanceTranslator1.add(web3.utils.toBN(Math.floor(roundInfo[2]))).toString(), // First 2 rounds have the same feeRewards value so we don't need to get info directly from each round.
      "Incorrect translator balance after withdrawing from the first round"
    );

    // Check that 'amountWithdrawable' function returns the correct amount.
    assert.equal(
      newBalanceTranslator2.toString(),
      oldBalanceTranslator.add(web3.utils.toBN(Math.floor(amountTranslator))).toString(),
      "Getter function does not return correct withdrawable amount for translator"
    );

    const oldBalanceChallenger = web3.utils.toBN(await web3.eth.getBalance(challenger));
    await linguo.batchRoundWithdraw(challenger, 0, 0, 2, {
      from: governor,
    });
    const newBalanceChallenger1 = web3.utils.toBN(await web3.eth.getBalance(challenger));
    assert.equal(
      newBalanceChallenger1.toString(),
      oldBalanceChallenger.toString(),
      "Challenger balance should stay the same after withdrawing from the first 2 rounds"
    );

    await linguo.batchRoundWithdraw(challenger, 0, 0, 20, {
      from: governor,
    });

    const newBalanceChallenger2 = web3.utils.toBN(await web3.eth.getBalance(challenger));
    assert.equal(
      newBalanceChallenger2.toString(),
      newBalanceChallenger1.add(web3.utils.toBN(Math.floor(0.5 * loserAppealFee))).toString(),
      "Incorrect challenger balance after withdrawing from the last round"
    );

    // Check that 'amountWithdrawable' function returns the correct amount.
    assert.equal(
      newBalanceChallenger2.toString(),
      oldBalanceChallenger.add(web3.utils.toBN(Math.floor(amountChallenger))).toString(),
      "Getter function does not return correct withdrawable amount for challenger"
    );
  });
});
