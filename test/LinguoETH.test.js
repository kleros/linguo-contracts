const {ethers} = require("@nomiclabs/buidler");
const {solidity} = require("ethereum-waffle");
const {use, expect} = require("chai");
const {randomInt, getEmittedEvent, latestTime, increaseTime} = require("../src/test-helpers");
const TaskStatus = require("../src/entities/TaskStatus");
const TaskParty = require("../src/entities/TaskParty");
const DisputeRuling = require("../src/entities/DisputeRuling");

use(solidity);

const {BigNumber} = ethers;

describe("Token contract", async () => {
  const arbitrationFee = BigNumber.from(BigInt(1e18));
  const arbitratorExtraData = "0x85";
  const appealTimeout = 100;
  const reviewTimeout = 2400;
  const translationMultiplier = 1000;
  const sharedMultiplier = 5000;
  const winnerMultiplier = 3000;
  const loserMultiplier = 7000;
  const NON_PAYABLE_VALUE = BigNumber.from((2n ** 256n - 2n) / 2n);
  const taskMinPrice = BigNumber.from(BigInt(1e18));
  const taskMaxPrice = BigNumber.from(BigInt(5e18));
  const submissionTimeout = 3600;
  const translatedText = "/ipfs/QmaozNR7DZHQK1ZcU9p7QdrshMvXqWK6gpu5rmrkPdT3L4";
  const challengeEvidence = "/ipfs/QmbUSy8HCn8J4TMDRRdxCbK2uCCtkQyZtY6XYv3y7kLgDC";
  const evidence = "/ipfs/QmZtmD2qt6fJot32nabSP3CUjicnypEBz7bHVDhPQt9aAy";

  let arbitrator;
  let governor;
  let requester;
  let translator;
  let challenger;
  let other;
  let crowdfunder1;
  let crowdfunder2;

  let contract;
  let MULTIPLIER_DIVISOR;
  let currentTime;
  let secondsPassed;

  let taskTx;
  let taskTxReceipt;
  let taskID;
  let task;

  beforeEach("Setup contracts", async () => {
    [governor, requester, translator, challenger, other, crowdfunder1, crowdfunder2] = await ethers.getSigners();

    const Arbitrator = await ethers.getContractFactory("EnhancedAppealableArbitrator");
    arbitrator = await Arbitrator.deploy(
      String(arbitrationFee),
      ethers.constants.AddressZero,
      arbitratorExtraData,
      appealTimeout
    );

    await arbitrator.deployed();
    // Make appeals go to the same arbitrator
    await arbitrator.changeArbitrator(arbitrator.address);

    const LinguoETH = await ethers.getContractFactory("LinguoETH", governor);
    contract = await LinguoETH.deploy(
      arbitrator.address,
      arbitratorExtraData,
      reviewTimeout,
      translationMultiplier,
      sharedMultiplier,
      winnerMultiplier,
      loserMultiplier
    );
    await contract.deployed();

    MULTIPLIER_DIVISOR = await contract.MULTIPLIER_DIVISOR();
    currentTime = await latestTime();
    // Because of time fluctuation the timeout stored in the contract can deviate a little from the variable value.
    // So subtract small amount to prevent the time increase going out of timeout range.

    taskTx = await contract
      .connect(requester)
      .createTask(currentTime + submissionTimeout, taskMinPrice, "TestMetaEvidence", {
        value: taskMaxPrice,
      });
    taskTxReceipt = await taskTx.wait();
    [taskID, task] = getEmittedEvent("TaskStateUpdated", taskTxReceipt).args;

    secondsPassed = randomInt(submissionTimeout - 5);
    await increaseTime(secondsPassed);
  });

  describe("Initialization", () => {
    it("Should set the correct values in constructor", async () => {
      expect(await contract.arbitrator()).to.equal(arbitrator.address, "Arbitrator address not properly set");
      expect(await contract.arbitratorExtraData()).to.equal(
        arbitratorExtraData,
        "Arbitrator extra data not properly set"
      );
      expect(await contract.reviewTimeout()).to.equal(reviewTimeout, "Review timeout not properly set");
      expect(await contract.translationMultiplier()).to.equal(
        translationMultiplier,
        "Translation multiplier not properly set"
      );
      expect(await contract.sharedStakeMultiplier()).to.equal(sharedMultiplier, "Shared multiplier not properly set");
      expect(await contract.winnerStakeMultiplier()).to.equal(winnerMultiplier, "Winner multiplier not properly set");
      expect(await contract.loserStakeMultiplier()).to.equal(loserMultiplier, "Loser multiplier not properly set");
    });
  });

  describe("Create new task", () => {
    it("Should create a task when parameters are valid", async () => {
      currentTime = await latestTime();
      const deadline = currentTime + submissionTimeout;
      const metaEvidence = "TestMetaEvidence";
      const requesterAddress = await requester.getAddress();

      const txPromise = contract.connect(requester).createTask(deadline, taskMinPrice, metaEvidence, {
        value: taskMaxPrice,
      });

      const expectedTaskId = 1;

      await expect(txPromise).to.emit(contract, "TaskCreated").withArgs(expectedTaskId, requesterAddress);
      await expect(txPromise).to.emit(contract, "MetaEvidence").withArgs(expectedTaskId, metaEvidence);
    });

    it("Should emit a TaskStateUpdated event with the correct params for the newly created task", async () => {
      currentTime = await latestTime();
      const deadline = currentTime + submissionTimeout;
      const metaEvidence = "TestMetaEvidence";
      const requesterAddress = await requester.getAddress();

      const tx = await contract.connect(requester).createTask(deadline, taskMinPrice, metaEvidence, {
        value: taskMaxPrice,
      });

      const receipt = await tx.wait();

      const [newTaskId, newTask] = getEmittedEvent("TaskStateUpdated", receipt).args;

      expect(newTaskId).to.equal(1, "Invalid task ID");
      expect(newTask.status).to.equal(TaskStatus.Created, "Invalid status");
      expect(newTask.requester).to.equal(requesterAddress, "Invalid requester address");
      expect(Number(newTask.submissionTimeout)).to.be.closeTo(submissionTimeout, 10, "Invalid submission timeout");
      expect(Number(newTask.lastInteraction)).to.be.closeTo(currentTime, 10, "Invalid last interaction");
      expect(newTask.minPrice).to.equal(taskMinPrice, "Invalid min price");
      expect(newTask.maxPrice).to.equal(taskMaxPrice, "Wron max price");
      expect(newTask.requesterDeposit).to.equal(taskMaxPrice, "Invalid requester deposit");
      expect(newTask.sumDeposit).to.equal(0, "Invalid sum depoist");
      expect(newTask.disputeID).to.equal(0, "Invalid dispute ID");
      expect(newTask.ruling).to.equal(0, "Invalid ruling");
      expect(newTask.parties).to.deep.equal(Array(3).fill(ethers.constants.AddressZero), "Invalid parties");
    });

    it("Should store the proper hashed task state of the newly created task", async () => {
      currentTime = await latestTime();
      const deadline = currentTime + submissionTimeout;
      const metaEvidence = "TestMetaEvidence";

      const tx = await contract.connect(requester).createTask(deadline, taskMinPrice, metaEvidence, {
        value: taskMaxPrice,
      });

      const receipt = await tx.wait();

      const [newTaskId, newTask] = getEmittedEvent("TaskStateUpdated", receipt).args;

      const actualHash = await contract.taskHashes(newTaskId);
      const expectedHash = await contract.hashTaskState(newTask);

      expect(actualHash).to.equal(expectedHash, "Invalid task state hash");
    });

    it("Should revert when maxPrice is lower than minPrice", async () => {
      currentTime = await latestTime();
      const deadline = currentTime + submissionTimeout;
      const metaEvidence = "TestMetaEvidence";

      const tx = contract.connect(requester).createTask(deadline, taskMinPrice, metaEvidence, {
        value: taskMinPrice.sub(1),
      });

      await expect(tx).to.be.revertedWith("Deposit value too low");
    });

    it("Should revert when deadline is before current time", async () => {
      currentTime = await latestTime();
      const deadline = currentTime - 1;
      const metaEvidence = "TestMetaEvidence";

      const tx = contract.connect(requester).createTask(deadline, taskMinPrice, metaEvidence, {
        value: taskMaxPrice,
      });

      await expect(tx).to.be.revertedWith("Deadline must be in the future");
    });
  });

  describe("Task price", () => {
    it("Should return the correct task price before submission timeout", async () => {
      const expectedPrice = taskMinPrice.add(taskMaxPrice.sub(taskMinPrice).mul(secondsPassed).div(submissionTimeout));
      const delta = expectedPrice.div(100);

      const actualPrice = await contract.getTaskPrice(taskID, task);

      expect(actualPrice.sub(expectedPrice).abs()).to.be.lt(delta, "Invalid task price");
    });

    it("Should return the correct task price after submission timout has passed", async () => {
      await increaseTime(submissionTimeout + 1);
      const expectedPrice = BigNumber.from(0);

      const actualPrice = await contract.getTaskPrice(taskID, task);

      expect(actualPrice).to.equal(expectedPrice, "Invalid task price");
    });

    it("Should return the correct task price when status is not `created`", async () => {
      const requiredDeposit = await contract.getTranslatorDeposit(taskID, task);
      // Adds an amount that would be enough to cover difference in price due to time increase
      const safeDeposit = requiredDeposit.add(BigNumber.from(String(1e17)));
      const [_, updatedTask] = await updateTaskState(contract.assignTask(taskID, task, {value: safeDeposit}));

      const expectedPrice = BigNumber.from(0);
      const actualPrice = await contract.getTaskPrice(taskID, updatedTask);

      expect(actualPrice).to.equal(expectedPrice, "Invalid task price");
    });

    it("Should revert when task data does not match the stored task hash", async () => {
      const corruptedTask = {
        ...task,
        maxPrice: BigNumber.from(0),
      };

      await expect(contract.getTaskPrice(taskID, corruptedTask)).to.be.revertedWith("Task does not match stored hash");
    });
  });

  describe("Translator deposit", () => {
    it("Should return the correct deposit value before submission timeout", async () => {
      const price = await contract.getTaskPrice(taskID, task);
      const expectedDeposit = arbitrationFee.add(price.mul(translationMultiplier).div(MULTIPLIER_DIVISOR));
      const delta = expectedDeposit.div(100);

      const actualDeposit = await contract.getTranslatorDeposit(taskID, task);

      expect(actualDeposit.sub(expectedDeposit).abs()).to.be.lt(delta, "Invalid translator deposit");
    });

    it("Should return the correct deposit value after submission timout has passed", async () => {
      await increaseTime(submissionTimeout + 1);
      const expectedDeposit = NON_PAYABLE_VALUE;

      const actualDeposit = await contract.getTranslatorDeposit(taskID, task);

      expect(actualDeposit).to.equal(expectedDeposit, "Invalid translator deposit");
    });

    it("Should return the correct deposit value when status is not `created`", async () => {
      const requiredDeposit = await contract.getTranslatorDeposit(taskID, task);
      // Adds an amount that would be enough to cover difference in price due to time increase
      const safeDeposit = requiredDeposit.add(BigNumber.from(String(1e17)));
      const [_, updatedTask] = await updateTaskState(contract.assignTask(taskID, task, {value: safeDeposit}));

      const expectedDeposit = NON_PAYABLE_VALUE;
      const actualDeposit = await contract.getTranslatorDeposit(taskID, updatedTask);

      expect(actualDeposit).to.equal(expectedDeposit, "Invalid translator deposit");
    });

    it("Should revert when task data does not match the stored task hash", async () => {
      const corruptedTask = {
        ...task,
        maxPrice: BigNumber.from(0),
      };

      await expect(contract.getTranslatorDeposit(taskID, corruptedTask)).to.be.revertedWith(
        "Task does not match stored hash"
      );
    });
  });

  describe("Assign task", () => {
    it("Should emit a TaskAssigned event when assigning the task to a translator", async () => {
      const expectedPrice = await contract.getTaskPrice(taskID, task);
      const delta = expectedPrice.div(100);
      const [_, __, {txPromise, receipt}] = await assignTaskHelper(taskID, task);

      await expect(txPromise).to.emit(contract, "TaskAssigned");

      const [actualTaskID, actualTranslator, actualPrice] = getEmittedEvent("TaskAssigned", receipt).args;
      expect(actualTaskID).to.equal(taskID);
      expect(actualTranslator).to.equal(await translator.getAddress());
      expect(actualPrice.sub(expectedPrice).abs()).to.be.lt(delta, "Invalid task assigned price");
    });

    it("Should emit a TaskStateUpdated event when assigning the task to a translator", async () => {
      const [_, __, {txPromise}] = await assignTaskHelper(taskID, task);

      await expect(txPromise).to.emit(contract, "TaskStateUpdated");
    });

    it("Should update the task state when assigning the task to a translator", async () => {
      const requiredDeposit = await contract.getTranslatorDeposit(taskID, task);
      const delta = requiredDeposit.div(100);

      const [actualTaskID, actualTask, {receipt}] = await assignTaskHelper(taskID, task);
      const {_price: assignedPrice} = getEmittedEvent("TaskAssigned", receipt).args;
      const actualHash = await contract.taskHashes(actualTaskID);
      const expectedHash = await contract.hashTaskState(actualTask);

      expect(actualTaskID).to.equal(taskID, "Assigned wrong task");
      expect(actualTask.status).to.equal(TaskStatus.Assigned, "Invalid status");
      expect(actualTask.parties[TaskParty.Translator]).to.equal(await translator.getAddress(), "Invalid translator");
      expect(actualTask.requesterDeposit).to.equal(assignedPrice, "Invalid price");
      expect(actualTask.sumDeposit.sub(requiredDeposit).abs()).to.be.lt(delta, "Invalid sumDeposit");
      expect(actualHash).to.equal(expectedHash, "Invalid task state hash");
    });

    it("Should send the remaining requester deposit back to the requester when assigning the task to a translator", async () => {
      const requesterBalanceBefore = await requester.getBalance();

      const [_, actualTask, {receipt}] = await assignTaskHelper(taskID, task);
      const {_price: assignedPrice} = getEmittedEvent("TaskAssigned", receipt).args;

      const requesterBalanceAfter = await requester.getBalance();

      const remainingDeposit = actualTask.maxPrice.sub(assignedPrice);
      expect(requesterBalanceAfter).to.equal(
        requesterBalanceBefore.add(remainingDeposit),
        "Did not send the remaing requester deposit back to the requester"
      );
    });

    it("Should revert when sending less than the required translator deposit", async () => {
      const requiredDeposit = await contract.getTranslatorDeposit(taskID, task);
      const attemptedDeposit = requiredDeposit.sub(1000);

      await expect(contract.assignTask(taskID, task, {value: attemptedDeposit})).to.be.revertedWith(
        "Deposit value too low"
      );
    });

    it("Should revert when the deadline has already passed", async () => {
      const requiredDeposit = await contract.getTranslatorDeposit(taskID, task);
      // Adds an amount that would be enough to cover difference in price due to time increase
      const safeDeposit = requiredDeposit.add(BigNumber.from(String(1e17)));

      await increaseTime(submissionTimeout + 3600);

      await expect(contract.assignTask(taskID, task, {value: safeDeposit})).to.be.revertedWith("Deadline has passed");
    });

    it("Should revert when task is already assigned", async () => {
      const requiredDeposit = await contract.getTranslatorDeposit(taskID, task);
      // Adds an amount that would be enough to cover difference in price due to time increase
      const safeDeposit = requiredDeposit.add(BigNumber.from(String(1e17)));

      const [_, assignedTask] = await assignTaskHelper(taskID, task);

      await expect(contract.assignTask(taskID, assignedTask, {value: safeDeposit})).to.be.revertedWith(
        "Invalid task status"
      );
    });

    it("Should revert when task data does not match the stored task hash", async () => {
      const [_, assignedTask] = await assignTaskHelper(taskID, task);
      const corruptedTask = {
        ...assignedTask,
        submissionTimeout: submissionTimeout * 2,
      };

      await expect(contract.assignTask(taskID, corruptedTask)).to.be.revertedWith("Task does not match stored hash");
    });
  });

  describe("Submit translation", () => {
    let assignedTask;

    beforeEach("Assign task to translator", async () => {
      const [_, updatedTask] = await assignTaskHelper(taskID, task);

      assignedTask = updatedTask;
    });

    it("Should emit a TranslationSubmitted event when the translator submits the translated text", async () => {
      const [_, __, {txPromise}] = await submitTranslationHelper(taskID, assignedTask, translatedText);

      await expect(txPromise)
        .to.emit(contract, "TranslationSubmitted")
        .withArgs(taskID, await translator.getAddress(), translatedText);
    });

    it("Should update the task state when the translator submits the translated text", async () => {
      const [actualTaskID, actualTask] = await submitTranslationHelper(taskID, assignedTask, translatedText);
      const currentTime = await latestTime();

      const actualHash = await contract.taskHashes(actualTaskID);
      const expectedHash = await contract.hashTaskState(actualTask);

      expect(actualTask.status).to.equal(TaskStatus.InReview, "Invalid status");
      expect(actualTask.lastInteraction).to.equal(currentTime, "Invalid lastInteraction");
      expect(actualHash).to.equal(expectedHash, "Invalid task state hash");
    });

    it("Should not allow anyone else other than the translator to submit the translated text", async () => {
      const connectedContract = contract.connect(other);

      expect(connectedContract.submitTranslation(taskID, assignedTask, translatedText)).to.be.revertedWith(
        "Only translator is allowed"
      );
    });

    it("Should not allow translator to submit the translated text after the deadline has passed", async () => {
      const connectedContract = contract.connect(translator);
      await increaseTime(submissionTimeout + 3600);

      expect(connectedContract.submitTranslation(taskID, assignedTask, translatedText)).to.be.revertedWith(
        "Deadline has passed"
      );
    });

    it("Should revert when task data does not match the stored task hash", async () => {
      const corruptedTask = {
        ...assignedTask,
        submissionTimeout: submissionTimeout * 2,
      };

      await expect(contract.submitTranslation(taskID, corruptedTask, translatedText)).to.be.revertedWith(
        "Task does not match stored hash"
      );
    });
  });

  describe("Reimburse requester", () => {
    it("Should reimburse the requester if no translator picked the task before the deadline has passed", async () => {
      await increaseTime(submissionTimeout + 3600);

      await expect(() => contract.reimburseRequester(taskID, task)).to.changeBalance(requester, taskMaxPrice);
    });

    it("Should emit a TaskResolved event when the requester is reimbursed", async () => {
      const [_, __, {txPromise}] = await reimburseRequesterHelper(taskID, task);

      await expect(txPromise).to.emit(contract, "TaskResolved").withArgs(taskID, "requester-reimbursed");
    });

    it("Should update the task state when the requester is reimbursed", async () => {
      const [_, updatedTask] = await reimburseRequesterHelper(taskID, task);

      const actualHash = await contract.taskHashes(taskID);
      const expectedHash = await contract.hashTaskState(updatedTask);

      expect(updatedTask.status).to.equal(TaskStatus.Resolved, "Invalid task status");
      expect(updatedTask.requesterDeposit).to.equal(BigNumber.from(0), "Invalid requesterDeposit");
      expect(updatedTask.sumDeposit).to.equal(BigNumber.from(0), "Invalid requesterDeposit");
      expect(actualHash).to.equal(expectedHash, "Invalid task state hash");
    });

    it("Should reimburse the requester if the translator did not submit the task before the deadline has passed", async () => {
      const [_, assignedTask] = await assignTaskHelper(taskID, task);
      await increaseTime(submissionTimeout + 3600);

      // The requester takes the translator deposit as well.
      const expectedBalanceChange = assignedTask.requesterDeposit.add(assignedTask.sumDeposit);

      await expect(() => contract.reimburseRequester(taskID, assignedTask)).to.changeBalance(
        requester,
        expectedBalanceChange
      );
    });

    it("Should not be possible to reimburse if submission timeout has not passed", async () => {
      await increaseTime(100);

      await expect(contract.reimburseRequester(taskID, task)).to.be.revertedWith("Deadline has not passed");
    });

    it("Should revert when task data does not match the stored task hash", async () => {
      await increaseTime(submissionTimeout + 3600);
      const corruptedTask = {
        ...task,
        requesterDeposit: taskMaxPrice.mul(BigNumber.from(2)),
      };

      await expect(contract.reimburseRequester(taskID, corruptedTask)).to.be.revertedWith(
        "Task does not match stored hash"
      );
    });
  });

  describe("Accept translation", () => {
    let taskInReview;

    beforeEach("Assign task to translator and submit translation", async () => {
      const [_1, assignedTask] = await assignTaskHelper(taskID, task);
      const [_2, challengedTask] = await submitTranslationHelper(taskID, assignedTask, translatedText);

      taskInReview = challengedTask;
    });

    it("Should emit a TaskResolved event when the review timeout has passed without a challenge", async () => {
      const [_, __, {txPromise}] = await acceptTranslationHelper(taskID, taskInReview);

      await expect(txPromise).to.emit(contract, "TaskResolved").withArgs(taskID, "translation-accepted");
    });

    it("Should update the task state when translation is accepted", async () => {
      const [_, resolvedTask] = await acceptTranslationHelper(taskID, taskInReview);
      const actualHash = await contract.taskHashes(taskID);
      const expectedHash = await contract.hashTaskState(resolvedTask);

      expect(resolvedTask.status).to.equal(TaskStatus.Resolved, "Invalid task status");
      expect(resolvedTask.requesterDeposit).to.equal(BigNumber.from(0), "Invalid requesterDeposit");
      expect(resolvedTask.sumDeposit).to.equal(BigNumber.from(0), "Invalid requesterDeposit");
      expect(actualHash).to.equal(expectedHash, "Invalid task state hash");
    });

    it("Should pay the translator when the translation is accepted", async () => {
      const translatorBalanceBefore = await translator.getBalance();
      const taskPrice = taskInReview.requesterDeposit;
      const translatorDeposit = taskInReview.sumDeposit;
      const balanceChange = taskPrice.add(translatorDeposit);

      await acceptTranslationHelper(taskID, taskInReview);

      const translatorBalanceAfter = await translator.getBalance();

      expect(translatorBalanceAfter).to.equal(translatorBalanceBefore.add(balanceChange));
    });

    it("Should not accept the translation when review timeout has not passed yet", async () => {
      await increaseTime(reviewTimeout - 1000);

      await expect(contract.acceptTranslation(taskID, taskInReview)).to.be.revertedWith("Still in review period");
    });

    it("Should not accept the translation when the translation was challenged", async () => {
      const [_, challengedTask] = await challengeTranslationHelper(taskID, taskInReview, challengeEvidence);
      await increaseTime(reviewTimeout + 20);

      await expect(contract.acceptTranslation(taskID, challengedTask)).to.be.revertedWith("Invalid task status");
    });

    it("Should revert when task data does not match the stored task hash", async () => {
      const corruptedTask = {
        ...taskInReview,
        sumDeposit: taskMaxPrice.mul(BigNumber.from(2)),
      };

      await expect(contract.acceptTranslation(taskID, corruptedTask)).to.be.revertedWith(
        "Task does not match stored hash"
      );
    });
  });

  describe("Challenge translation", () => {
    let sumbittedTask;

    beforeEach("Assign task to translator, submit and challenge", async () => {
      const [_1, assignedTask] = await assignTaskHelper(taskID, task);
      const [_2, updatedTask] = await submitTranslationHelper(taskID, assignedTask, translatedText);

      sumbittedTask = updatedTask;
    });

    it("Should emit both a TranslationChallenged, a Dispute and an Evidence events when someone challenges the translation with an evidence", async () => {
      const [_, __, {txPromise}] = await challengeTranslationHelper(taskID, sumbittedTask, challengeEvidence);

      await expect(txPromise)
        .to.emit(contract, "TranslationChallenged")
        .withArgs(taskID, await challenger.getAddress());
      await expect(txPromise)
        .to.emit(contract, "Dispute")
        .withArgs(arbitrator.address, BigNumber.from(0), taskID, taskID);
      await expect(txPromise)
        .to.emit(contract, "Evidence")
        .withArgs(arbitrator.address, taskID, await challenger.getAddress(), challengeEvidence);
    });

    it("Should emit only a TranslationChallenged and a Dispute events when someone challenges the translation without providing an evidence", async () => {
      const [_, __, {txPromise}] = await challengeTranslationHelper(taskID, sumbittedTask, "");

      await expect(txPromise).not.to.emit(contract, "Evidence");

      await expect(txPromise)
        .to.emit(contract, "TranslationChallenged")
        .withArgs(taskID, await challenger.getAddress());
      await expect(txPromise)
        .to.emit(contract, "Dispute")
        .withArgs(arbitrator.address, BigNumber.from(0), taskID, taskID);
    });

    it("Should update the task state when someone challenges the translation", async () => {
      const requiredDeposit = await contract.getChallengerDeposit(taskID, sumbittedTask);
      const arbitrationCost = await arbitrator.arbitrationCost(arbitratorExtraData);
      const previousSumDeposit = sumbittedTask.sumDeposit;
      const expectedFinalSumDeposit = previousSumDeposit.add(requiredDeposit).sub(arbitrationCost);

      const [actualTaskID, actualTask] = await challengeTranslationHelper(taskID, sumbittedTask, translatedText);
      const actualHash = await contract.taskHashes(actualTaskID);
      const expectedHash = await contract.hashTaskState(actualTask);

      expect(actualTaskID).to.equal(taskID, "Assigned wrong task");
      expect(actualTask.status).to.equal(TaskStatus.InDispute, "Invalid status");
      expect(actualTask.parties[TaskParty.Challenger]).to.equal(await challenger.getAddress(), "Invalid challenger");
      expect(actualTask.sumDeposit).to.equal(expectedFinalSumDeposit, "Invalid sumDeposit");
      expect(actualHash).to.equal(expectedHash, "Invalid task state hash");
    });

    it("Should update the rounds state of the translation", async () => {
      await challengeTranslationHelper(taskID, sumbittedTask, translatedText);

      const actualNumberOfRounds = await contract.getNumberOfRounds(taskID);
      const roundInfo = await contract.getRoundInfo(taskID, 0);

      const ZERO = BigNumber.from(0);

      expect(actualNumberOfRounds).to.equal(BigNumber.from(1), "Invalid number of rounds");
      expect(roundInfo.paidFees).to.deep.equal([ZERO, ZERO, ZERO]);
      expect(roundInfo.hasPaid).to.deep.equal([false, false, false]);
      expect(roundInfo.feeRewards).to.equal(ZERO);
    });

    it("Should update the task dispute state of the translation", async () => {
      const [_, challengedTask] = await challengeTranslationHelper(taskID, sumbittedTask, translatedText);

      const taskDispute = await contract.taskDisputesByDisputeID(challengedTask.disputeID);

      expect(taskDispute.exists).to.equal(true);
      expect(taskDispute.hasRuling).to.equal(false);
      expect(taskDispute.taskID).to.equal(taskID);
    });

    it("Should create a dispute on the arbitrator when someone challenges a translation", async () => {
      const expectedNoOfChoices = BigNumber.from(2);

      await challengeTranslationHelper(taskID, sumbittedTask, translatedText);

      const dispute = await arbitrator.disputes(0);
      expect(dispute.arbitrated).to.equal(contract.address, "Arbitrable not set up properly");
      expect(dispute.choices).to.equal(expectedNoOfChoices);
    });

    it("Should not be allowed to challenge if the review period has already passed", async () => {
      const connectedContract = contract.connect(challenger);
      const requiredDeposit = await connectedContract.getChallengerDeposit(taskID, sumbittedTask);

      await increaseTime(reviewTimeout + 1);

      const txPromise = connectedContract.challengeTranslation(taskID, sumbittedTask, challengeEvidence, {
        value: requiredDeposit,
      });

      await expect(txPromise).to.be.revertedWith("Review period has passed");
    });

    it("Should not be allowed to challenge if the task was already resolved", async () => {
      const connectedContract = contract.connect(challenger);
      const requiredDeposit = await connectedContract.getChallengerDeposit(taskID, sumbittedTask);
      await increaseTime(reviewTimeout + 1);
      const [_, acceptedTask] = await updateTaskState(connectedContract.acceptTranslation(taskID, sumbittedTask));

      const txPromise = connectedContract.challengeTranslation(taskID, acceptedTask, challengeEvidence, {
        value: requiredDeposit,
      });

      await expect(txPromise).to.be.revertedWith("Invalid task status");
    });

    it("Should not be allowed to challenge if challenger deposit value is too low", async () => {
      const connectedContract = contract.connect(challenger);
      const requiredDeposit = await connectedContract.getChallengerDeposit(taskID, sumbittedTask);
      const actualDeposit = requiredDeposit.sub(BigNumber.from(1));

      const txPromise = connectedContract.challengeTranslation(taskID, sumbittedTask, challengeEvidence, {
        value: actualDeposit,
      });

      await expect(txPromise).to.be.revertedWith("Deposit value too low");
    });

    it("Should revert when task data does not match the stored task hash", async () => {
      const corruptedTask = {
        ...sumbittedTask,
        sumDeposit: sumbittedTask.sumDeposit.mul(BigNumber.from(2)),
      };

      await expect(contract.assignTask(taskID, corruptedTask)).to.be.revertedWith("Task does not match stored hash");
    });
  });

  describe("Submit evidence", () => {
    let challengedTask;

    beforeEach("Assign task to translator, submit and challenge", async () => {
      const [_1, assignedTask] = await assignTaskHelper(taskID, task);
      const [_2, submittedTask] = await submitTranslationHelper(taskID, assignedTask, translatedText);
      const [_3, updatedTask] = await challengeTranslationHelper(taskID, submittedTask, challengeEvidence);

      challengedTask = updatedTask;
    });

    it("Should emit an Evidence event when one of the parties submits an evidence", async () => {
      const txPromise = contract.connect(translator).submitEvidence(taskID, challengedTask, evidence);

      await expect(txPromise)
        .to.emit(contract, "Evidence")
        .withArgs(arbitrator.address, taskID, challengedTask.parties[TaskParty.Translator], evidence);
    });

    it("Should allow a 3rd-party to submit an Evidence in its behalf", async () => {
      const txPromise = contract.connect(other).submitEvidence(taskID, challengedTask, evidence);

      await expect(txPromise)
        .to.emit(contract, "Evidence")
        .withArgs(arbitrator.address, taskID, await other.getAddress(), evidence);
    });

    it("Should not allow to submit an evidence if the task dispute already has a ruling", async () => {
      const ruling = DisputeRuling.TranslationApproved;
      await giveFinalRulingHelper(task.disputeID, ruling);

      const txPromise = contract.submitEvidence(taskID, challengedTask, evidence);

      await expect(txPromise).to.be.revertedWith("Dispute already settled");
    });

    it("Should not allow to submit an evidence if the task is already resolved", async () => {
      const ruling = DisputeRuling.TranslationApproved;
      await giveFinalRulingHelper(task.disputeID, ruling);
      const [_, actualTask] = await executeRulingHelper(taskID, challengedTask);

      const txPromise = contract.submitEvidence(taskID, actualTask, evidence);

      await expect(txPromise).to.be.revertedWith("Dispute already settled");
    });
  });

  describe("Arbitrator gives ruling", () => {
    let challengedTask;

    beforeEach("Assign task to translator, submit and challenge", async () => {
      const [_1, assignedTask] = await assignTaskHelper(taskID, task);
      const [_2, submittedTask] = await submitTranslationHelper(taskID, assignedTask, translatedText);
      const [_3, updatedTask] = await challengeTranslationHelper(taskID, submittedTask, challengeEvidence);

      challengedTask = updatedTask;
    });

    it("Should emit a Ruling event when the arbitrator rules the dispute", async () => {
      const ruling = DisputeRuling.TranslationRejected;
      const {txPromise} = await giveFinalRulingHelper(challengedTask.disputeID, ruling);

      await expect(txPromise)
        .to.emit(contract, "Ruling")
        .withArgs(arbitrator.address, challengedTask.disputeID, ruling);
    });

    it("Should update the task dispute state when the arbitrator rules the dispute ", async () => {
      const ruling = DisputeRuling.TranslationApproved;
      await giveFinalRulingHelper(challengedTask.disputeID, ruling);

      const taskDispute = await contract.taskDisputesByDisputeID(challengedTask.disputeID);
      expect(taskDispute.exists).to.equal(true, "Task dispute should exist");
      expect(taskDispute.hasRuling).to.equal(true, "Task dispute should have ruling");
      expect(taskDispute.taskID).to.equal(taskID, "Wrong task");
    });
  });

  describe("Execute ruling", () => {
    let challengedTask;

    beforeEach("Assign task to translator, submit and challenge", async () => {
      const [_1, assignedTask] = await assignTaskHelper(taskID, task);
      const [_2, submittedTask] = await submitTranslationHelper(taskID, assignedTask, translatedText);
      const [_3, updatedTask] = await challengeTranslationHelper(taskID, submittedTask, challengeEvidence);

      challengedTask = updatedTask;
    });

    it("Should update the task state when the ruling is executed", async () => {
      const ruling = DisputeRuling.TranslationApproved;
      await giveFinalRulingHelper(challengedTask.disputeID, ruling);

      const [actualTaskID, actualTask] = await await executeRulingHelper(taskID, challengedTask);
      const actualHash = await contract.taskHashes(actualTaskID);
      const expectedHash = await contract.hashTaskState(actualTask);
      const ZERO = BigNumber.from(0);

      expect(actualTaskID).to.equal(taskID, "Executed on wrong task");
      expect(actualTask.status).to.equal(TaskStatus.Resolved, "Invalid status");
      expect(actualTask.ruling).to.equal(BigNumber.from(ruling), "Invalid ruling");
      expect(actualTask.requesterDeposit).to.equal(ZERO, "Invalid requesterDeposit");
      expect(actualTask.sumDeposit).to.equal(ZERO, "Invalid sumDeposit");
      expect(actualHash).to.equal(expectedHash, "Invalid task state hash");
    });

    it("Should emit a TaskResolved event with the correct reason when the ruling is executed", async () => {
      const ruling = DisputeRuling.TranslationApproved;
      await giveFinalRulingHelper(challengedTask.disputeID, ruling);

      const [actualTaskID, __, {txPromise}] = await await executeRulingHelper(taskID, challengedTask);

      await expect(txPromise).to.emit(contract, "TaskResolved").withArgs(actualTaskID, "dispute-settled");
    });

    it("Should pay all parties correctly when the arbitrator refused to rule", async () => {
      const ruling = DisputeRuling.RefusedToRule;
      const balancesBefore = {
        requester: await requester.getBalance(),
        translator: await translator.getBalance(),
        challenger: await challenger.getBalance(),
      };
      await giveFinalRulingHelper(challengedTask.disputeID, ruling);

      await executeRulingHelper(taskID, challengedTask);

      const balancesAfter = {
        requester: await requester.getBalance(),
        translator: await translator.getBalance(),
        challenger: await challenger.getBalance(),
      };

      const expectedBalances = {
        requester: balancesBefore.requester.add(challengedTask.requesterDeposit),
        translator: balancesBefore.translator.add(challengedTask.sumDeposit.div(BigNumber.from(2))),
        challenger: balancesBefore.challenger.add(challengedTask.sumDeposit.div(BigNumber.from(2))),
      };

      const delta = BigNumber.from(1000);

      expect(expectedBalances.requester.sub(balancesAfter.requester).abs()).to.be.lt(delta);
      expect(expectedBalances.translator.sub(balancesAfter.translator).abs()).to.be.lt(delta);
      expect(expectedBalances.challenger.sub(balancesAfter.challenger).abs()).to.be.lt(delta);
    });

    it("Should pay all parties correctly when the arbitrator approved the translation", async () => {
      const ruling = DisputeRuling.TranslationApproved;
      const balancesBefore = {
        requester: await requester.getBalance(),
        translator: await translator.getBalance(),
        challenger: await challenger.getBalance(),
      };
      await giveFinalRulingHelper(challengedTask.disputeID, ruling);

      await executeRulingHelper(taskID, challengedTask);

      const balancesAfter = {
        requester: await requester.getBalance(),
        translator: await translator.getBalance(),
        challenger: await challenger.getBalance(),
      };

      const expectedBalances = {
        requester: balancesBefore.requester,
        translator: balancesBefore.translator.add(challengedTask.requesterDeposit).add(challengedTask.sumDeposit),
        challenger: balancesBefore.challenger,
      };

      const delta = BigNumber.from(1000);

      expect(expectedBalances.requester.sub(balancesAfter.requester).abs()).to.be.lt(delta);
      expect(expectedBalances.translator.sub(balancesAfter.translator).abs()).to.be.lt(delta);
      expect(expectedBalances.challenger.sub(balancesAfter.challenger).abs()).to.be.lt(delta);
    });

    it("Should pay all parties correctly when the arbitrator rejected the translation", async () => {
      const ruling = DisputeRuling.TranslationRejected;
      const balancesBefore = {
        requester: await requester.getBalance(),
        translator: await translator.getBalance(),
        challenger: await challenger.getBalance(),
      };
      await giveFinalRulingHelper(challengedTask.disputeID, ruling);

      await executeRulingHelper(taskID, challengedTask);

      const balancesAfter = {
        requester: await requester.getBalance(),
        translator: await translator.getBalance(),
        challenger: await challenger.getBalance(),
      };

      const expectedBalances = {
        requester: balancesBefore.requester.add(challengedTask.requesterDeposit),
        translator: balancesBefore.translator,
        challenger: balancesBefore.challenger.add(challengedTask.sumDeposit),
      };

      const delta = BigNumber.from(1000);

      expect(expectedBalances.requester.sub(balancesAfter.requester).abs()).to.be.lt(delta);
      expect(expectedBalances.translator.sub(balancesAfter.translator).abs()).to.be.lt(delta);
      expect(expectedBalances.challenger.sub(balancesAfter.challenger).abs()).to.be.lt(delta);
    });
  });

  describe("Appeal decision", () => {
    let challengedTask;

    beforeEach("Assign task to translator, submit and challenge", async () => {
      const [_1, assignedTask] = await assignTaskHelper(taskID, task);
      const [_2, submittedTask] = await submitTranslationHelper(taskID, assignedTask, translatedText);
      const [_3, updatedTask] = await challengeTranslationHelper(taskID, submittedTask, challengeEvidence);

      challengedTask = updatedTask;
    });

    it("Should emit an AppealFeePaid and an AppealFeeContribution when a party pays the full appeal fee", async () => {
      const ruling = DisputeRuling.TranslationRejected;
      const loserParty = TaskParty.Translator;
      const loserSigner = translator;
      const loserAppealFee = arbitrationFee.add(arbitrationFee.mul(loserMultiplier).div(MULTIPLIER_DIVISOR));

      await giveRulingHelper(challengedTask.disputeID, ruling);
      const loserTx = await fundAppealHelper(taskID, challengedTask, loserAppealFee, loserParty);

      await expect(loserTx.txPromise).to.emit(contract, "AppealFeePaid").withArgs(taskID, loserParty);
      await expect(loserTx.txPromise)
        .to.emit(contract, "AppealFeeContribution")
        .withArgs(taskID, loserParty, await loserSigner.getAddress(), loserAppealFee);
    });

    it("Should update the round info state accordingly when a party pays the full appeal fee", async () => {
      const ruling = DisputeRuling.TranslationRejected;
      const loserParty = TaskParty.Translator;
      const winnerParty = TaskParty.Challenger;
      const loserAppealFee = arbitrationFee.add(arbitrationFee.mul(loserMultiplier).div(MULTIPLIER_DIVISOR));

      await giveRulingHelper(challengedTask.disputeID, ruling);
      await fundAppealHelper(taskID, challengedTask, loserAppealFee, loserParty);

      const roundInfo = await contract.getRoundInfo(taskID, 0);
      expect(roundInfo.paidFees[loserParty]).to.equal(loserAppealFee, "Invalid paidFees for party");
      expect(roundInfo.hasPaid[loserParty]).to.equal(true, "Invalid hasPaid for party");
      expect(roundInfo.paidFees[winnerParty]).to.equal(
        BigNumber.from(0),
        "Should not register paid fess for the other party"
      );
      expect(roundInfo.hasPaid[winnerParty]).to.equal(false, "Should not register as paid for the other party");
    });

    it("Should update the round info state accordingly when a party pays only a part of the appeal fee", async () => {
      const ruling = DisputeRuling.TranslationRejected;
      const loserParty = TaskParty.Translator;
      const winnerParty = TaskParty.Challenger;
      const loserAppealFee = arbitrationFee.add(arbitrationFee.mul(loserMultiplier).div(MULTIPLIER_DIVISOR));
      const paidFee = loserAppealFee.div(2);

      await giveRulingHelper(challengedTask.disputeID, ruling);
      await fundAppealHelper(taskID, challengedTask, paidFee, loserParty);

      const roundInfo = await contract.getRoundInfo(taskID, 0);
      expect(roundInfo.paidFees[loserParty]).to.equal(paidFee, "Invalid paidFees for party");
      expect(roundInfo.hasPaid[loserParty]).to.equal(false, "Invalid hasPaid for party");
      expect(roundInfo.paidFees[winnerParty]).to.equal(
        BigNumber.from(0),
        "Should not register paid fess for the other party"
      );
      expect(roundInfo.hasPaid[winnerParty]).to.equal(false, "Should not register as paid for the other party");
    });

    it("Should update the round info state accordingly when a party pays more that the appeal fee and send the remainig ETH back to the sender", async () => {
      const ruling = DisputeRuling.TranslationRejected;
      const loserParty = TaskParty.Translator;
      const loserSigner = translator;
      const loserAppealFee = arbitrationFee.add(arbitrationFee.mul(loserMultiplier).div(MULTIPLIER_DIVISOR));
      const paidFee = loserAppealFee.mul(10);
      const balanceBefore = await loserSigner.getBalance();

      await giveRulingHelper(challengedTask.disputeID, ruling);
      await fundAppealHelper(taskID, challengedTask, paidFee, loserParty);

      const roundInfo = await contract.getRoundInfo(taskID, 0);
      expect(roundInfo.paidFees[loserParty]).to.equal(loserAppealFee, "Invalid paidFees for party");
      expect(roundInfo.hasPaid[loserParty]).to.equal(true, "Invalid hasPaid for party");

      const balanceAfter = await loserSigner.getBalance();
      // Allow 1% difference
      const delta = balanceBefore.div(100);

      expect(balanceAfter.sub(balanceBefore).sub(loserAppealFee).abs()).to.be.lt(
        delta,
        "Invalid balance after funding"
      );
    });

    it("Should issue an appeal when both parties pay their respective fees", async () => {
      const ruling = DisputeRuling.TranslationRejected;
      const loserParty = TaskParty.Translator;
      const winnerParty = TaskParty.Challenger;
      const loserAppealFee = arbitrationFee.add(arbitrationFee.mul(loserMultiplier).div(MULTIPLIER_DIVISOR));
      const winnerAppealFee = arbitrationFee.add(arbitrationFee.mul(winnerMultiplier).div(MULTIPLIER_DIVISOR));

      await giveRulingHelper(challengedTask.disputeID, ruling);
      await fundAppealHelper(taskID, challengedTask, loserAppealFee, loserParty);
      const {txPromise} = await fundAppealHelper(taskID, challengedTask, winnerAppealFee, winnerParty);

      await expect(txPromise).to.emit(arbitrator, "AppealDecision").withArgs(task.disputeID, contract.address);
    });

    it("Should properly update the current round state when both parties pay their respective fees", async () => {
      const ruling = DisputeRuling.TranslationRejected;
      const loserParty = TaskParty.Translator;
      const winnerParty = TaskParty.Challenger;
      const loserAppealFee = arbitrationFee.add(arbitrationFee.mul(loserMultiplier).div(MULTIPLIER_DIVISOR));
      const winnerAppealFee = arbitrationFee.add(arbitrationFee.mul(winnerMultiplier).div(MULTIPLIER_DIVISOR));

      await giveRulingHelper(challengedTask.disputeID, ruling);
      await fundAppealHelper(taskID, challengedTask, loserAppealFee, loserParty);
      await fundAppealHelper(taskID, challengedTask, winnerAppealFee, winnerParty);

      const currentRoundInfo = await contract.getRoundInfo(taskID, 0);
      const ZERO = BigNumber.from(0);
      const expectedFeeRewards = loserAppealFee.add(winnerAppealFee).sub(arbitrationFee);

      expect(currentRoundInfo.feeRewards).to.equal(expectedFeeRewards, "Invalid new round feeRewards");
      expect(currentRoundInfo.paidFees).to.deep.equal(
        [ZERO, loserAppealFee, winnerAppealFee],
        "Invalid new round paidFees"
      );
      expect(currentRoundInfo.hasPaid).to.deep.equal([false, true, true], "Invalid new round hasPaid");
    });

    it("Should register a new round for the task when both parties pay their respective fees", async () => {
      const ruling = DisputeRuling.TranslationRejected;
      const loserParty = TaskParty.Translator;
      const winnerParty = TaskParty.Challenger;
      const loserAppealFee = arbitrationFee.add(arbitrationFee.mul(loserMultiplier).div(MULTIPLIER_DIVISOR));
      const winnerAppealFee = arbitrationFee.add(arbitrationFee.mul(winnerMultiplier).div(MULTIPLIER_DIVISOR));

      await giveRulingHelper(challengedTask.disputeID, ruling);
      await fundAppealHelper(taskID, challengedTask, loserAppealFee, loserParty);
      await fundAppealHelper(taskID, challengedTask, winnerAppealFee, winnerParty);

      const numberOfRounds = await contract.getNumberOfRounds(taskID);
      const latestRoundInfo = await contract.getRoundInfo(taskID, numberOfRounds.sub(BigNumber.from(1)));
      const ZERO = BigNumber.from(0);

      expect(numberOfRounds).to.equal(BigNumber.from(2), "Invalid number of rounds");
      expect(latestRoundInfo.feeRewards).to.equal(ZERO, "Invalid new round feeRewards");
      expect(latestRoundInfo.paidFees).to.deep.equal([ZERO, ZERO, ZERO], "Invalid new round paidFees");
      expect(latestRoundInfo.hasPaid).to.deep.equal([false, false, false], "Invalid new round hasPaid");
    });

    it("Should not allow the losing side to fund the appeal when the first half of the appeal period is over", async () => {
      const ruling = DisputeRuling.TranslationRejected;
      const loserParty = TaskParty.Translator;
      const loserSigner = translator;
      const loserAppealFee = arbitrationFee.add(arbitrationFee.mul(loserMultiplier).div(MULTIPLIER_DIVISOR));

      await giveRulingHelper(challengedTask.disputeID, ruling);
      await increaseTime(appealTimeout / 2);

      const txPromise = contract
        .connect(loserSigner)
        .fundAppeal(taskID, challengedTask, loserParty, {value: loserAppealFee});

      await expect(txPromise).to.be.revertedWith("1st half appeal period is over");
    });

    it("Should allow the winning side to fund the appeal even when the first half of the appeal period is over", async () => {
      const ruling = DisputeRuling.TranslationRejected;
      const loserParty = TaskParty.Translator;
      const loserAppealFee = arbitrationFee.add(arbitrationFee.mul(loserMultiplier).div(MULTIPLIER_DIVISOR));
      const winnerParty = TaskParty.Challenger;
      const winnerSigner = challenger;
      const winnerAppealFee = arbitrationFee.add(arbitrationFee.mul(winnerMultiplier).div(MULTIPLIER_DIVISOR));

      await giveRulingHelper(challengedTask.disputeID, ruling);
      await fundAppealHelper(taskID, challengedTask, loserAppealFee, loserParty);
      await increaseTime(appealTimeout / 2);

      const txPromise = contract
        .connect(winnerSigner)
        .fundAppeal(taskID, challengedTask, winnerParty, {value: winnerAppealFee});

      await expect(txPromise).not.to.be.reverted;
    });

    it("Should not allow the winning side to fund the appeal when appeal is over", async () => {
      const ruling = DisputeRuling.TranslationRejected;
      const loserParty = TaskParty.Translator;
      const loserAppealFee = arbitrationFee.add(arbitrationFee.mul(loserMultiplier).div(MULTIPLIER_DIVISOR));
      const winnerParty = TaskParty.Challenger;
      const winnerSigner = challenger;
      const winnerAppealFee = arbitrationFee.add(arbitrationFee.mul(winnerMultiplier).div(MULTIPLIER_DIVISOR));

      await giveRulingHelper(challengedTask.disputeID, ruling);
      await fundAppealHelper(taskID, challengedTask, loserAppealFee, loserParty);
      await increaseTime(appealTimeout + 1);

      const txPromise = contract
        .connect(winnerSigner)
        .fundAppeal(taskID, challengedTask, winnerParty, {value: winnerAppealFee});

      await expect(txPromise).to.be.revertedWith("Appeal period is over");
    });

    it("Should change the ruling when the loser paid the full appeal fee while the winner did not", async () => {
      const ruling = DisputeRuling.TranslationRejected;
      const loserParty = TaskParty.Translator;
      const loserAppealFee = arbitrationFee.add(arbitrationFee.mul(loserMultiplier).div(MULTIPLIER_DIVISOR));

      await giveRulingHelper(challengedTask.disputeID, ruling);
      await fundAppealHelper(taskID, challengedTask, loserAppealFee, loserParty);
      await increaseTime(appealTimeout + 1);
      const {txPromise} = await giveRulingHelper(challengedTask.disputeID, ruling);

      const [_, actualTask] = await executeRulingHelper(taskID, challengedTask);

      const expectedRuling = DisputeRuling.TranslationApproved;
      const taskDispute = await contract.taskDisputesByDisputeID(taskID);

      await expect(txPromise)
        .to.emit(contract, "Ruling")
        .withArgs(arbitrator.address, actualTask.disputeID, expectedRuling);
      expect(actualTask.ruling).to.equal(expectedRuling);
      expect(taskDispute.ruling).to.equal(expectedRuling);
    });

    it("Should pay the parties accordingly upon executeRuling when the loser paid the full appeal fee while the winner did not", async () => {
      const ruling = DisputeRuling.TranslationRejected;
      const loserParty = TaskParty.Translator;
      const loserAppealFee = arbitrationFee.add(arbitrationFee.mul(loserMultiplier).div(MULTIPLIER_DIVISOR));

      await giveRulingHelper(challengedTask.disputeID, ruling);
      await fundAppealHelper(taskID, challengedTask, loserAppealFee, loserParty);

      const balancesBefore = {
        requester: await requester.getBalance(),
        translator: await translator.getBalance(),
        challenger: await challenger.getBalance(),
      };

      await increaseTime(appealTimeout + 1);
      await giveRulingHelper(challengedTask.disputeID, ruling);
      await executeRulingHelper(taskID, challengedTask);

      const balancesAfter = {
        requester: await requester.getBalance(),
        translator: await translator.getBalance(),
        challenger: await challenger.getBalance(),
      };

      /* Translation was rejected by the arbitrator, however the ruling
       * was changed because the winner failed to pay the appeal fee.
       */
      const expectedBalances = {
        requester: balancesBefore.requester,
        translator: balancesBefore.translator.add(challengedTask.requesterDeposit).add(challengedTask.sumDeposit),
        challenger: balancesBefore.challenger,
      };

      const delta = BigNumber.from(10000);

      expect(expectedBalances.requester.sub(balancesAfter.requester).abs()).to.be.lt(
        delta,
        "Invalid balance for requester"
      );
      expect(expectedBalances.translator.sub(balancesAfter.translator).abs()).to.be.lt(
        delta,
        "Invalid balance for translator"
      );
      expect(expectedBalances.challenger.sub(balancesAfter.challenger).abs()).to.be.lt(
        delta,
        "Invalid balance for challenger"
      );
    });

    it("Should store the account contribution to the appeal funding", async () => {
      const ruling = DisputeRuling.TranslationRejected;
      const loserAppealFee = arbitrationFee.add(arbitrationFee.mul(loserMultiplier).div(MULTIPLIER_DIVISOR));
      const contributedAmount = loserAppealFee.div(10);

      await giveRulingHelper(challengedTask.disputeID, ruling);
      await fundAppealHelper(taskID, challengedTask, contributedAmount, TaskParty.Translator, other);

      const actualContributions = await contract.getContributions(taskID, await other.getAddress(), 0);

      expect(actualContributions[TaskParty.Translator]).to.equal(contributedAmount, "Invalid contribution stored");
    });
  });

  describe("Calculate withdrawable appeal fees and rewards", () => {
    let challengedTask;

    beforeEach("Assign task to translator, submit and challenge", async () => {
      const [_1, assignedTask] = await assignTaskHelper(taskID, task);
      const [_2, submittedTask] = await submitTranslationHelper(taskID, assignedTask, translatedText);
      const [_3, updatedTask] = await challengeTranslationHelper(taskID, submittedTask, challengeEvidence);

      challengedTask = updatedTask;
    });

    it("Should calculate the proper amounts withdrawable by each party when the translation is approved", async () => {
      const ruling = DisputeRuling.TranslationApproved;

      const [_, resolvedTask, __, appealFees] = await fundAppealAndResolveHelper(taskID, challengedTask, ruling);

      const actualAmounts = {
        translator: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await translator.getAddress()),
        challenger: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await challenger.getAddress()),
      };

      const expectedAmounts = {
        translator: appealFees[TaskParty.Translator].add(appealFees[TaskParty.Challenger]).sub(arbitrationFee),
        challenger: BigNumber.from(0),
      };

      expect(actualAmounts.translator).to.equal(
        expectedAmounts.translator,
        "Invalid withdrawable amount for translator"
      );
      expect(actualAmounts.challenger).to.equal(
        expectedAmounts.challenger,
        "Invalid withdrawable amount for challenger"
      );
    });

    it("Should calculate the proper amounts withdrawable by each party when the translation is rejected", async () => {
      const ruling = DisputeRuling.TranslationRejected;

      const [_, resolvedTask, __, appealFees] = await fundAppealAndResolveHelper(taskID, challengedTask, ruling);

      const actualAmounts = {
        translator: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await translator.getAddress()),
        challenger: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await challenger.getAddress()),
      };

      const expectedAmounts = {
        translator: BigNumber.from(0),
        challenger: appealFees[TaskParty.Challenger].add(appealFees[TaskParty.Translator]).sub(arbitrationFee),
      };

      expect(actualAmounts.translator).to.equal(
        expectedAmounts.translator,
        "Invalid withdrawable amount for translator"
      );
      expect(actualAmounts.challenger).to.equal(
        expectedAmounts.challenger,
        "Invalid withdrawable amount for challenger"
      );
    });

    it("Should calculate the proper amounts withdrawable by each party when arbitrator refuses to rule", async () => {
      const ruling = DisputeRuling.RefusedToRule;

      const [_, resolvedTask, __, appealFees] = await fundAppealAndResolveHelper(taskID, challengedTask, ruling);

      const actualAmounts = {
        translator: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await translator.getAddress()),
        challenger: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await challenger.getAddress()),
      };

      const expectedAmounts = {
        translator: appealFees[TaskParty.Translator].sub(arbitrationFee.div(2)),
        challenger: appealFees[TaskParty.Challenger].sub(arbitrationFee.div(2)),
      };

      expect(actualAmounts.translator).to.equal(
        expectedAmounts.translator,
        "Invalid withdrawable amount for translator"
      );
      expect(actualAmounts.challenger).to.equal(
        expectedAmounts.challenger,
        "Invalid withdrawable amount for challenger"
      );
    });

    it("Should calculate the proper amounts withdrawable by each party when the appeal reverts the first round decision", async () => {
      const firstRuling = DisputeRuling.TranslationApproved;
      const finalRuling = DisputeRuling.TranslationRejected;

      const [_, resolvedTask, __, appealFees] = await fundAppealAndResolveHelper(
        taskID,
        challengedTask,
        firstRuling,
        finalRuling
      );

      const actualAmounts = {
        translator: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await translator.getAddress()),
        challenger: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await challenger.getAddress()),
      };

      const expectedAmounts = {
        translator: BigNumber.from(0),
        challenger: appealFees[TaskParty.Challenger].add(appealFees[TaskParty.Translator]).sub(arbitrationFee),
      };

      expect(actualAmounts.translator).to.equal(
        expectedAmounts.translator,
        "Invalid withdrawable amount for translator"
      );
      expect(actualAmounts.challenger).to.equal(
        expectedAmounts.challenger,
        "Invalid withdrawable amount for challenger"
      );
    });
  });

  describe("Crowdfunding: calculate withdrawable appeal fees and rewards", () => {
    let challengedTask;

    beforeEach("Assign task to translator, submit and challenge", async () => {
      const [_1, assignedTask] = await assignTaskHelper(taskID, task);
      const [_2, submittedTask] = await submitTranslationHelper(taskID, assignedTask, translatedText);
      const [_3, updatedTask] = await challengeTranslationHelper(taskID, submittedTask, challengeEvidence);

      challengedTask = updatedTask;
    });

    it("Should calculate the amount withdrawable by each crowdfunder proportional to their contribution when the translation is approved", async () => {
      const ruling = DisputeRuling.TranslationApproved;

      const [_, resolvedTask, __, appealFees] = await crowdfundAppealFeeAndResolveHelper(
        taskID,
        challengedTask,
        ruling
      );

      const actualAmounts = {
        translator: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await translator.getAddress()),
        crowdfunder1: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await crowdfunder1.getAddress()),
        challenger: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await challenger.getAddress()),
        crowdfunder2: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await crowdfunder2.getAddress()),
      };

      const availableFeesAndRewards = appealFees[TaskParty.Translator]
        .add(appealFees[TaskParty.Challenger])
        .sub(arbitrationFee);

      const expectedAmounts = {
        translator: availableFeesAndRewards.div(BigNumber.from(2)),
        crowdfunder1: availableFeesAndRewards.div(BigNumber.from(2)),
        challenger: BigNumber.from(0),
        crowdfunder2: BigNumber.from(0),
      };

      expect(actualAmounts.translator).to.equal(
        expectedAmounts.translator,
        "Invalid withdrawable amount for translator"
      );
      expect(actualAmounts.crowdfunder1).to.equal(
        expectedAmounts.crowdfunder1,
        "Invalid withdrawable amount for crowfunder supporting translator"
      );
      expect(actualAmounts.challenger).to.equal(
        expectedAmounts.challenger,
        "Invalid withdrawable amount for challenger"
      );
      expect(actualAmounts.crowdfunder2).to.equal(
        expectedAmounts.crowdfunder2,
        "Invalid withdrawable amount for crowfunder supporting challenger"
      );
    });

    it("Should calculate the amount withdrawable by each crowdfunder proportioinal to their contribution when the translation is rejected", async () => {
      const ruling = DisputeRuling.TranslationRejected;

      const [_, resolvedTask, __, appealFees] = await crowdfundAppealFeeAndResolveHelper(
        taskID,
        challengedTask,
        ruling
      );

      const actualAmounts = {
        translator: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await translator.getAddress()),
        crowdfunder1: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await crowdfunder1.getAddress()),
        challenger: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await challenger.getAddress()),
        crowdfunder2: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await crowdfunder2.getAddress()),
      };

      const availableFeesAndRewards = appealFees[TaskParty.Challenger]
        .add(appealFees[TaskParty.Translator])
        .sub(arbitrationFee);

      const expectedAmounts = {
        translator: BigNumber.from(0),
        crowdfunder1: BigNumber.from(0),
        challenger: availableFeesAndRewards.div(BigNumber.from(2)),
        crowdfunder2: availableFeesAndRewards.div(BigNumber.from(2)),
      };

      expect(actualAmounts.translator).to.equal(
        expectedAmounts.translator,
        "Invalid withdrawable amount for translator"
      );
      expect(actualAmounts.crowdfunder1).to.equal(
        expectedAmounts.crowdfunder1,
        "Invalid withdrawable amount for crowfunder supporting translator"
      );
      expect(actualAmounts.challenger).to.equal(
        expectedAmounts.challenger,
        "Invalid withdrawable amount for challenger"
      );
      expect(actualAmounts.crowdfunder2).to.equal(
        expectedAmounts.crowdfunder2,
        "Invalid withdrawable amount for crowfunder supporting challenger"
      );
    });

    it("Should calculate the amount withdrawable by each crowdfunder proportional to their contribution when arbitrator refuses to rule", async () => {
      const ruling = DisputeRuling.RefusedToRule;

      const [_, resolvedTask, __, appealFees] = await crowdfundAppealFeeAndResolveHelper(
        taskID,
        challengedTask,
        ruling
      );

      const actualAmounts = {
        translator: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await translator.getAddress()),
        crowdfunder1: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await crowdfunder1.getAddress()),
        challenger: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await challenger.getAddress()),
        crowdfunder2: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await crowdfunder2.getAddress()),
      };

      const availableFeesAndRewards = {
        translator: appealFees[TaskParty.Translator].sub(arbitrationFee.div(2)),
        challenger: appealFees[TaskParty.Challenger].sub(arbitrationFee.div(2)),
      };

      const expectedAmounts = {
        translator: availableFeesAndRewards.translator.div(2),
        crowdfunder1: availableFeesAndRewards.translator.div(2),
        challenger: availableFeesAndRewards.challenger.div(2),
        crowdfunder2: availableFeesAndRewards.challenger.div(2),
      };

      expect(actualAmounts.translator).to.equal(
        expectedAmounts.translator,
        "Invalid withdrawable amount for translator"
      );
      expect(actualAmounts.crowdfunder1).to.equal(
        expectedAmounts.crowdfunder1,
        "Invalid withdrawable amount for crowfunder supporting translator"
      );
      expect(actualAmounts.challenger).to.equal(
        expectedAmounts.challenger,
        "Invalid withdrawable amount for challenger"
      );
      expect(actualAmounts.crowdfunder2).to.equal(
        expectedAmounts.crowdfunder2,
        "Invalid withdrawable amount for crowfunder supporting challenger"
      );
    });

    it("Should calculate the amount withdrawable by each crowdfunder proportional to their contribution when the appeal reverts the first round decision", async () => {
      const firstRuling = DisputeRuling.TranslationApproved;
      const finalRuling = DisputeRuling.TranslationRejected;

      const [_, resolvedTask, __, appealFees] = await crowdfundAppealFeeAndResolveHelper(
        taskID,
        challengedTask,
        firstRuling,
        finalRuling
      );

      const actualAmounts = {
        translator: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await translator.getAddress()),
        crowdfunder1: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await crowdfunder1.getAddress()),
        challenger: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await challenger.getAddress()),
        crowdfunder2: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await crowdfunder2.getAddress()),
      };

      const availableFeesAndRewards = appealFees[TaskParty.Challenger]
        .add(appealFees[TaskParty.Translator])
        .sub(arbitrationFee);

      const expectedAmounts = {
        translator: BigNumber.from(0),
        crowdfunder1: BigNumber.from(0),
        challenger: availableFeesAndRewards.div(BigNumber.from(2)),
        crowdfunder2: availableFeesAndRewards.div(BigNumber.from(2)),
      };

      expect(actualAmounts.translator).to.equal(
        expectedAmounts.translator,
        "Invalid withdrawable amount for translator"
      );
      expect(actualAmounts.crowdfunder1).to.equal(
        expectedAmounts.crowdfunder1,
        "Invalid withdrawable amount for crowfunder supporting translator"
      );
      expect(actualAmounts.challenger).to.equal(
        expectedAmounts.challenger,
        "Invalid withdrawable amount for challenger"
      );
      expect(actualAmounts.crowdfunder2).to.equal(
        expectedAmounts.crowdfunder2,
        "Invalid withdrawable amount for crowfunder supporting challenger"
      );
    });
  });

  describe("Batch withdraw fees and rewards", () => {
    let challengedTask;

    beforeEach("Assign task to translator, submit and challenge", async () => {
      const [_1, assignedTask] = await assignTaskHelper(taskID, task);
      const [_2, submittedTask] = await submitTranslationHelper(taskID, assignedTask, translatedText);
      const [_3, updatedTask] = await challengeTranslationHelper(taskID, submittedTask, challengeEvidence);

      challengedTask = updatedTask;
    });

    it("Should withdraw the full withdrawable amount for each party proportional to their contribution when the translation is approved", async () => {
      const ruling = DisputeRuling.TranslationApproved;

      const [_, resolvedTask, __, appealFees] = await crowdfundAppealFeeAndResolveHelper(
        taskID,
        challengedTask,
        ruling
      );

      const availableFeesAndRewards = appealFees[TaskParty.Translator]
        .add(appealFees[TaskParty.Challenger])
        .sub(arbitrationFee);

      const balancesBefore = {
        translator: await translator.getBalance(),
        crowdfunder1: await crowdfunder1.getBalance(),
        challenger: await challenger.getBalance(),
        crowdfunder2: await crowdfunder2.getBalance(),
      };

      const expectedBalances = {
        translator: balancesBefore.translator.add(availableFeesAndRewards.div(BigNumber.from(2))),
        crowdfunder1: balancesBefore.crowdfunder1.add(availableFeesAndRewards.div(BigNumber.from(2))),
        challenger: balancesBefore.challenger,
        crowdfunder2: balancesBefore.crowdfunder2,
      };

      await batchWithdrawHelper(taskID, resolvedTask, [
        await translator.getAddress(),
        await crowdfunder1.getAddress(),
        await challenger.getAddress(),
        await crowdfunder2.getAddress(),
      ]);

      const balancesAfter = {
        translator: await translator.getBalance(),
        crowdfunder1: await crowdfunder1.getBalance(),
        challenger: await challenger.getBalance(),
        crowdfunder2: await crowdfunder2.getBalance(),
      };

      expect(balancesAfter.translator).to.equal(
        expectedBalances.translator,
        "Invalid withdrawable amount for translator"
      );
      expect(balancesAfter.crowdfunder1).to.equal(
        expectedBalances.crowdfunder1,
        "Invalid withdrawable amount for crowdfunder1"
      );
      expect(balancesAfter.challenger).to.equal(
        expectedBalances.challenger,
        "Invalid withdrawable amount for challenger"
      );
      expect(balancesAfter.crowdfunder2).to.equal(
        expectedBalances.crowdfunder2,
        "Invalid withdrawable amount for crowdfunder2"
      );
    });

    it("Should reimburse the contributed fees to each party when the appeal funding is not complete for both sides", async () => {
      const ruling = DisputeRuling.TranslationApproved;
      const loserParty = TaskParty.Challenger;
      const winnerParty = TaskParty.Translator;

      const loserAppealFee = arbitrationFee.add(arbitrationFee.mul(loserMultiplier).div(MULTIPLIER_DIVISOR));
      const winnerAppealFee = arbitrationFee.add(arbitrationFee.mul(winnerMultiplier).div(MULTIPLIER_DIVISOR));

      const loserContributedFee = loserAppealFee.sub(BigNumber.from(1));
      const winnerContributedFee = winnerAppealFee.sub(BigNumber.from(1));

      await giveRulingHelper(challengedTask.disputeID, ruling);

      await fundAppealHelper(taskID, challengedTask, loserContributedFee, loserParty, challenger);
      await fundAppealHelper(taskID, challengedTask, winnerContributedFee, winnerParty, translator);

      await increaseTime(appealTimeout + 1);
      await giveRulingHelper(challengedTask.disputeID, ruling);
      const [_, resolvedTask] = await executeRulingHelper(taskID, challengedTask);

      const balancesBefore = {
        translator: await translator.getBalance(),
        challenger: await challenger.getBalance(),
      };

      await batchWithdrawHelper(taskID, resolvedTask, [await translator.getAddress(), await challenger.getAddress()]);

      const balancesAfter = {
        translator: await translator.getBalance(),
        challenger: await challenger.getBalance(),
      };

      const expectedBalances = {
        translator: balancesBefore.translator.add(winnerContributedFee),
        challenger: balancesBefore.challenger.add(loserContributedFee),
      };

      expect(balancesAfter.translator).to.equal(expectedBalances.translator, "Invalid balance for translator");
      expect(balancesAfter.challenger).to.equal(expectedBalances.challenger, "Invalid balance for challenger");
    });

    it("Should zero out the withdrawable amount for the winner party after the withdraw is made", async () => {
      const ruling = DisputeRuling.TranslationApproved;
      const [_, resolvedTask] = await fundAppealAndResolveHelper(taskID, challengedTask, ruling);

      await batchWithdrawHelper(taskID, resolvedTask, [await translator.getAddress()]);
      const actualWithdrawableAmount = await contract.getTotalWithdrawableAmount(
        taskID,
        resolvedTask,
        await translator.getAddress()
      );

      expect(actualWithdrawableAmount).to.equal(BigNumber.from(0), "Invalid balance after withdraw");
    });

    it("Should zero out the withdrawable amount for the both parties when there is no winner after both withdraw", async () => {
      const ruling = DisputeRuling.RefusedToRule;
      const [_, resolvedTask] = await fundAppealAndResolveHelper(taskID, challengedTask, ruling);

      await batchWithdrawHelper(taskID, resolvedTask, [await translator.getAddress(), await challenger.getAddress()]);

      const actualAmounts = {
        translator: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await translator.getAddress()),
        challenger: await contract.getTotalWithdrawableAmount(taskID, resolvedTask, await challenger.getAddress()),
      };

      expect(actualAmounts.translator).to.equal(BigNumber.from(0), "Invalid translator balance after withdraw");
      expect(actualAmounts.challenger).to.equal(BigNumber.from(0), "Invalid challenger balance after withdraw");
    });

    it("Should not allow the winner party to withdraw funds more than once for a given task", async () => {
      const ruling = DisputeRuling.TranslationApproved;

      const [_, resolvedTask, __, appealFees] = await fundAppealAndResolveHelper(taskID, challengedTask, ruling);

      const balanceBefore = await translator.getBalance();

      await batchWithdrawHelper(taskID, resolvedTask, [await translator.getAddress()]);

      const balanceInBetween = await translator.getBalance();

      await batchWithdrawHelper(taskID, resolvedTask, [await translator.getAddress()]);

      const balanceAfter = await translator.getBalance();

      const expectedBalanceChange = appealFees[TaskParty.Translator]
        .add(appealFees[TaskParty.Challenger])
        .sub(arbitrationFee);

      expect(balanceInBetween).to.equal(
        balanceBefore.add(expectedBalanceChange),
        "Invalid balance in between withdraws"
      );
      expect(balanceAfter).to.equal(balanceInBetween, "Double-spend detected");
    });
  });

  async function updateTaskState(txPromise) {
    const tx = await txPromise;
    const receipt = await tx.wait();
    const event = getEmittedEvent("TaskStateUpdated", receipt);

    if (!event) {
      throw new Error("TaskStateUpdated event was not emitted during the transaction");
    }

    const [updatedTaskId, updatedTask] = event.args;

    return [updatedTaskId, updatedTask, {txPromise, tx, receipt}];
  }

  async function assignTaskHelper(taskID, task, signer = translator) {
    const connectedContract = contract.connect(signer);

    const requiredDeposit = await connectedContract.getTranslatorDeposit(taskID, task);
    // Adds an amount that would be enough to cover difference in price due to time increase
    const safeDeposit = requiredDeposit.add(BigNumber.from(String(1e17)));

    const txPromise = connectedContract.assignTask(taskID, task, {value: safeDeposit});
    return updateTaskState(txPromise);
  }

  async function submitTranslationHelper(taskID, task, translatedText, signer = translator) {
    const connectedContract = contract.connect(signer);

    const txPromise = connectedContract.submitTranslation(taskID, task, translatedText);
    return updateTaskState(txPromise);
  }

  async function reimburseRequesterHelper(taskID, task, signer = translator) {
    const connectedContract = contract.connect(signer);
    await increaseTime(submissionTimeout + 3600);

    const txPromise = connectedContract.reimburseRequester(taskID, task);
    return updateTaskState(txPromise);
  }

  async function acceptTranslationHelper(taskID, task, signer = requester) {
    const connectedContract = contract.connect(signer);
    await increaseTime(reviewTimeout + 1);

    const txPromise = connectedContract.acceptTranslation(taskID, task);
    return updateTaskState(txPromise);
  }

  async function challengeTranslationHelper(taskID, task, evidence, signer = challenger) {
    const connectedContract = contract.connect(signer);
    const requiredDeposit = await connectedContract.getChallengerDeposit(taskID, task);

    const txPromise = connectedContract.challengeTranslation(taskID, task, evidence, {value: requiredDeposit});
    return updateTaskState(txPromise);
  }

  async function fundAppealHelper(
    taskID,
    task,
    value,
    side,
    signer = side === TaskParty.Translator ? translator : challenger
  ) {
    const connectedContract = contract.connect(signer);
    const txPromise = connectedContract.fundAppeal(taskID, task, side, {value});
    const tx = await txPromise;
    const receipt = await tx.wait();

    return {txPromise, tx, receipt};
  }

  async function giveRulingHelper(disputeID, ruling) {
    const txPromise = arbitrator.giveRuling(disputeID, ruling);
    const tx = await txPromise;
    const receipt = await tx.wait();

    return {txPromise, tx, receipt};
  }

  async function giveFinalRulingHelper(disputeID, ruling) {
    const firstTx = await arbitrator.giveRuling(disputeID, ruling);
    await firstTx.wait();

    await increaseTime(appealTimeout + 1);

    const txPromise = arbitrator.giveRuling(disputeID, ruling);
    const tx = await txPromise;
    const receipt = await tx.wait();

    return {txPromise, tx, receipt};
  }

  async function executeRulingHelper(taskID, task) {
    return updateTaskState(contract.executeRuling(taskID, task));
  }

  async function fundAppealAndResolveHelper(taskID, task, firstRuling, appealRuling = firstRuling) {
    const appealFees = {};

    await giveRulingHelper(task.disputeID, firstRuling);

    if (firstRuling === DisputeRuling.RefusedToRule) {
      const appealFee = arbitrationFee.add(arbitrationFee.mul(sharedMultiplier).div(MULTIPLIER_DIVISOR));

      await fundAppealHelper(taskID, task, appealFee, TaskParty.Translator);
      await fundAppealHelper(taskID, task, appealFee, TaskParty.Challenger);

      appealFees[TaskParty.Translator] = appealFee;
      appealFees[TaskParty.Challenger] = appealFee;
    } else {
      const loserParty =
        firstRuling === DisputeRuling.TranslationRejected ? TaskParty.Translator : TaskParty.Challenger;
      const winnerParty =
        firstRuling === DisputeRuling.TranslationApproved ? TaskParty.Translator : TaskParty.Challenger;
      const loserAppealFee = arbitrationFee.add(arbitrationFee.mul(loserMultiplier).div(MULTIPLIER_DIVISOR));
      const winnerAppealFee = arbitrationFee.add(arbitrationFee.mul(winnerMultiplier).div(MULTIPLIER_DIVISOR));

      await fundAppealHelper(taskID, task, loserAppealFee, loserParty);
      await fundAppealHelper(taskID, task, winnerAppealFee, winnerParty);

      appealFees[TaskParty.Translator] =
        firstRuling === DisputeRuling.TranslationRejected ? loserAppealFee : winnerAppealFee;
      appealFees[TaskParty.Challenger] =
        firstRuling === DisputeRuling.TranslationApproved ? loserAppealFee : winnerAppealFee;
    }

    const appealDisputeID = await arbitrator.getAppealDisputeID(task.disputeID);
    await giveFinalRulingHelper(appealDisputeID, appealRuling);

    return [...(await executeRulingHelper(taskID, task)), appealFees];
  }

  /**
   * Advances past the whole appeal process with croundfunding.
   * Translator fees are split 50/50 paid by translator and crowdfunder1
   * Challenger fees are split 50/50 paid by challenger and crowdfunder2
   */
  async function crowdfundAppealFeeAndResolveHelper(taskID, task, firstRuling, appealRuling = firstRuling) {
    const appealFees = {};

    await giveRulingHelper(task.disputeID, firstRuling);

    if (firstRuling === DisputeRuling.RefusedToRule) {
      const appealFee = arbitrationFee.add(arbitrationFee.mul(sharedMultiplier).div(MULTIPLIER_DIVISOR));
      const paidFee = appealFee.div(BigNumber.from(2));

      await fundAppealHelper(taskID, task, paidFee, TaskParty.Translator, translator);
      await fundAppealHelper(taskID, task, paidFee, TaskParty.Translator, crowdfunder1);
      await fundAppealHelper(taskID, task, paidFee, TaskParty.Challenger, challenger);
      await fundAppealHelper(taskID, task, paidFee, TaskParty.Challenger, crowdfunder2);

      appealFees[TaskParty.Translator] = appealFee;
      appealFees[TaskParty.Challenger] = appealFee;
    } else {
      const translatorSide = {
        signer: translator,
        crowdfunder: crowdfunder1,
        party: TaskParty.Translator,
      };

      const challengerSide = {
        signer: challenger,
        crowdfunder: crowdfunder2,
        party: TaskParty.Challenger,
      };

      const loserSide = firstRuling === DisputeRuling.TranslationApproved ? challengerSide : translatorSide;
      const winnerSide = firstRuling === DisputeRuling.TranslationRejected ? challengerSide : translatorSide;

      const loserAppealFee = arbitrationFee.add(arbitrationFee.mul(loserMultiplier).div(MULTIPLIER_DIVISOR));
      const winnerAppealFee = arbitrationFee.add(arbitrationFee.mul(winnerMultiplier).div(MULTIPLIER_DIVISOR));
      const paidLoserAppealFee = loserAppealFee.div(BigNumber.from(2));
      const paidWinnerAppealFee = winnerAppealFee.div(BigNumber.from(2));

      await fundAppealHelper(taskID, task, paidLoserAppealFee, loserSide.party, loserSide.signer);
      await fundAppealHelper(taskID, task, paidLoserAppealFee, loserSide.party, loserSide.crowdfunder);
      await fundAppealHelper(taskID, task, paidWinnerAppealFee, winnerSide.party, winnerSide.signer);
      await fundAppealHelper(taskID, task, paidWinnerAppealFee, winnerSide.party, winnerSide.crowdfunder);

      appealFees[loserSide.party] = loserAppealFee;
      appealFees[winnerSide.party] = winnerAppealFee;
    }

    const appealDisputeID = await arbitrator.getAppealDisputeID(task.disputeID);
    await giveFinalRulingHelper(appealDisputeID, appealRuling);

    return [...(await executeRulingHelper(taskID, task)), appealFees];
  }

  async function batchWithdrawHelper(taskID, task, addresses = []) {
    const txs = await Promise.all(
      addresses.map((address) => contract.batchWithdrawFeesAndRewards(taskID, task, address, 0, 0))
    );
    return Promise.all(txs.map((tx) => tx.wait()));
  }
});
