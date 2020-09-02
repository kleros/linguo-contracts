/**
 * @authors: [@hbarcelos]
 * @reviewers: []
 * @auditors: []
 * @bounties: []
 * @deployments: []
 *
 * SPDX-License-Identifier: MIT
 */

pragma solidity >=0.6.9;
pragma experimental ABIEncoderV2;

import "@kleros/erc-792/contracts/IArbitrable.sol";
import "@kleros/erc-792/contracts/IArbitrator.sol";
import "@kleros/erc-792/contracts/erc-1497/IEvidence.sol";
import "@kleros/ethereum-libraries/contracts/CappedMath.sol";

contract LinguoETH is IArbitrable, IEvidence {
    using CappedMath for uint256;

    /**
     * @dev Value that represents the version of the contract.
     * The value is incremented each time the new version is deployed.
     * Range for LinguoETH: 0-127, LinguoToken: 128-255.
     */
    uint8 public constant VERSION_ID = 0;

    /// @dev Divisor parameter for multipliers.
    uint248 public constant MULTIPLIER_DIVISOR = 10000;

    /// @dev A value depositor won't be able to pay.
    uint256 private constant NON_PAYABLE_VALUE = (2**256 - 2) / 2;

    /**
     * @dev To be emitted whenever a task state is updated.
     * @param _taskID The ID of the changed task.
     * @param _task The full task data after update.
     */
    event TaskStateUpdated(uint256 indexed _taskID, Task _task);

    /**
     * @dev To be emitted when the new task is created.
     * @param _taskID The ID of the newly created task.
     * @param _requester The address that created the task.
     */
    event TaskCreated(uint256 indexed _taskID, address indexed _requester);

    /**
     * @dev To be emitted when a translator is assigned to a task.
     * @param _taskID The ID of the assigned task.
     * @param _translator The address that was assigned to the task.
     * @param _price The price of the task at the moment of the assignment.
     */
    event TaskAssigned(uint256 indexed _taskID, address indexed _translator, uint256 _price);

    /**
     * @dev To be emitted when a translation is submitted.
     * @param _taskID The ID of the respective task.
     * @param _translator The address that performed the translation.
     * @param _translatedText The URI to the translated text.
     */
    event TranslationSubmitted(uint256 indexed _taskID, address indexed _translator, string _translatedText);

    /**
     * @dev To be emitted when a translation is challenged.
     * @param _taskID The ID of the respective task.
     * @param _challenger The address of the challenger.
     */
    event TranslationChallenged(uint256 indexed _taskID, address indexed _challenger);

    /**
     * @dev To be emitted when a task is resolved, either by the translation being accepted, the requester being reimbursed or a dispute being settled.
     * @param _taskID The ID of the respective task.
     * @param _reason Short description of what caused the task to be solved. One of: 'translation-accepted' | 'requester-reimbursed' | 'dispute-settled'
     */
    event TaskResolved(uint256 indexed _taskID, string _reason);

    /**
     * @dev To be emitted when someone contributes to the appeal process.
     * @param _taskID The ID of the respective task.
     * @param _party The party which received the contribution.
     * @param _contributor The address of the contributor.
     * @param _amount The amount contributed.
     */
    event AppealFeeContribution(uint256 indexed _taskID, Party _party, address _contributor, uint256 _amount);

    /**
     * @dev To be emitted when the appeal fees of one of the parties are fully funded.
     * @param _taskID The ID of the respective task.
     * @param _party The party that is fully funded.
     */
    event AppealFeePaid(uint256 indexed _taskID, Party _party);

    enum Status {Created, Assigned, InReview, InDispute, Resolved}

    enum Party {
        None, // Party that is mapped with 0 dispute ruling.
        Translator, // The one performing translation task.
        Challenger // The one challenging translated text in the review period.
    }

    /**
     * @notice Arrays of 3 elements in the Task and Round structs map to the parties.
     * Index "0" is not used, "1" is used for translator and "2" for challenger.
     */
    struct Task {
        Status status; // Status of the task.
        address payable requester; // The party requesting the translation.
        uint256 submissionTimeout; // Time in seconds allotted for submitting a translation.
        uint256 lastInteraction; // The time of the last action performed on the task. Note that lastInteraction is updated only during timeout-related actions such as the creation of the task and the submission of the translation.
        uint256 minPrice; // Minimal price for the translation. When the task is created it has minimal price that gradually increases such as it reaches maximal price at deadline.
        uint256 maxPrice; // Maximal price for the translation and also value that must be deposited by the requester.
        uint256 requesterDeposit; // The deposit requester makes when creating the task. Once a task is assigned this deposit will be partially reimbursed and its value replaced by task price.
        uint256 translatorDeposit; // The deposit of the translator, if any. This value will be paid to the party that wins the dispute.
        uint256 disputeID; // The ID of the dispute created in arbitrator contract.
        uint256 ruling; // Ruling given to the dispute of the task by the arbitrator.
        address payable[3] parties; // Translator and challenger of the task.
    }

    /**
     * @dev Tracks the state of eventual disputes created by a challenge.
     */
    struct TaskDispute {
        bool exists; // Required to control whether a given dispute for a task exists.
        bool hasRuling; // Required to differentiate between having no ruling and a RefusedToRule ruling.
        uint256 taskID; // The task ID.
        uint256 ruling; // The ruling given by the arbitrator.
    }

    /**
     * @dev Tracks the state of an appeal round.
     */
    struct Round {
        uint256[3] paidFees; // Tracks the fees paid by each side in this round.
        bool[3] hasPaid; // True when the side has fully paid its fee. False otherwise.
        uint256 feeRewards; // Sum of reimbursable fees and stake rewards available to the parties that made contributions to the side that ultimately wins a dispute.
        mapping(address => uint256[3]) contributions; // Maps contributors to their contributions for each side.
    }

    /// @dev The governor of the contract.
    address public governor;

    /// @dev The arbitrator to solve disputes.
    IArbitrator public arbitrator;

    /// @dev The arbitrator extra data.
    bytes public arbitratorExtraData;

    /// @dev Time in seconds during which the submitted translation can be challenged.
    uint256 public reviewTimeout;

    /// @notice All multipliers below are in basis points.

    /// @dev Multiplier for calculating the value of the deposit translator must pay to self-assign a task.
    uint256 public translationMultiplier;

    /// @dev Multiplier for calculating the appeal fee that must be paid by submitter in the case where there isn't a winner and loser (e.g. when the arbitrator ruled "refuse to arbitrate").
    uint256 public sharedStakeMultiplier;

    /// @dev Multiplier for calculating the appeal fee of the party that won the previous round.
    uint256 public winnerStakeMultiplier;

    /// @dev  Multiplier for calculating the appeal fee of the party that lost the previous round.
    uint256 public loserStakeMultiplier;

    /// @dev Stores the hashes of all tasks.
    bytes32[] public taskHashes;

    /// @dev Maps a taskID to its respective appeal rounds.
    mapping(uint256 => Round[]) public roundsByTaskID;

    /// @dev Maps a disputeID to its respective task dispute.
    mapping(uint256 => TaskDispute) public taskDisputesByDisputeID;

    /**
     * @notice _arbitrator is trusted and will not re-enter. It must support an appeal period.
     * @param _arbitrator An instance of an arbitrator as defined in ERC-792.
     * @param _arbitratorExtraData The arbitrator extra data.
     * @param _reviewTimeout Time in seconds during which the submitted translation can be challenged.
     * @param _translationMultiplier Multiplier for calculating the value of the deposit translator must pay to self-assign a task.
     * @param _sharedStakeMultiplier  Multiplier for calculating the appeal fee that must be paid by submitter in the case where there isn't a winner and loser (e.g. when the arbitrator ruled "refuse to arbitrate").
     * @param _winnerStakeMultiplier Multiplier for calculating the appeal fee of the party that won the previous round.
     * @param _loserStakeMultiplier Multiplier for calculating the appeal fee of the party that lost the previous round.
     */
    constructor(
        IArbitrator _arbitrator,
        bytes memory _arbitratorExtraData,
        uint256 _reviewTimeout,
        uint256 _translationMultiplier,
        uint256 _sharedStakeMultiplier,
        uint256 _winnerStakeMultiplier,
        uint256 _loserStakeMultiplier
    ) public {
        governor = msg.sender;
        arbitrator = _arbitrator;
        arbitratorExtraData = _arbitratorExtraData;
        reviewTimeout = _reviewTimeout;
        translationMultiplier = _translationMultiplier;
        sharedStakeMultiplier = _sharedStakeMultiplier;
        winnerStakeMultiplier = _winnerStakeMultiplier;
        loserStakeMultiplier = _loserStakeMultiplier;
    }

    modifier onlyValidTask(uint256 _taskID, Task memory _task) {
        require(taskHashes[_taskID] == hashTaskState(_task), "Task does not match stored hash");
        _;
    }

    modifier onlyGovernor() {
        require(msg.sender == governor, "Only governor is allowed");
        _;
    }

    /**
     * @dev Changes the governor of this contract.
     * @param _governor A new governor.
     */
    function changeGovernor(address _governor) public onlyGovernor {
        governor = _governor;
    }

    /**
     * @dev Changes the time allocated for review phase.
     * @param _reviewTimeout A new value of the time allotted for reviewing a translation. In seconds.
     */
    function changeReviewTimeout(uint256 _reviewTimeout) public onlyGovernor {
        reviewTimeout = _reviewTimeout;
    }

    /**
     * @dev Changes the multiplier for translator's deposit.
     * @param _translationMultiplier A new value of the multiplier for calculating translator's deposit. In basis points.
     */
    function changeTranslationMultiplier(uint256 _translationMultiplier) public onlyGovernor {
        translationMultiplier = _translationMultiplier;
    }

    /**
     * @dev Changes the percentage of arbitration fees that must be paid by parties as a fee stake if there was no winner and loser in the previous round.
     * @param _sharedStakeMultiplier A new value of the multiplier of the appeal cost in case when there is no winner/loser in previous round. In basis point.
     */
    function changeSharedStakeMultiplier(uint256 _sharedStakeMultiplier) public onlyGovernor {
        sharedStakeMultiplier = _sharedStakeMultiplier;
    }

    /**
     * @dev Changes the percentage of arbitration fees that must be paid as a fee stake by the party that won the previous round.
     * @param _winnerStakeMultiplier A new value of the multiplier of the appeal cost that the winner of the previous round has to pay. In basis points.
     */
    function changeWinnerStakeMultiplier(uint256 _winnerStakeMultiplier) public onlyGovernor {
        winnerStakeMultiplier = _winnerStakeMultiplier;
    }

    /**
     * @dev Changes the percentage of arbitration fees that must be paid as a fee stake by the party that lost the previous round.
     * @param _loserStakeMultiplier A new value of the multiplier of the appeal cost that the party that lost the previous round has to pay. In basis points.
     */
    function changeLoserStakeMultiplier(uint256 _loserStakeMultiplier) public onlyGovernor {
        loserStakeMultiplier = _loserStakeMultiplier;
    }

    /**
     * @dev Creates a task based on provided details.
     * Requires a value of maximum price to be deposited.
     * @param _deadline The deadline for the translation to be completed.
     * @param _minPrice A minimal price of the translation. In wei.
     * @param _metaEvidence A URI of meta-evidence object for task submission.
     * @return taskID The ID of the created task.
     */
    function createTask(
        uint256 _deadline,
        uint256 _minPrice,
        string calldata _metaEvidence
    ) public payable returns (uint256) {
        require(msg.value >= _minPrice, "Deposit value too low");
        require(_deadline > block.timestamp, "Deadline must be in the future");

        Task memory task;
        task.submissionTimeout = _deadline - block.timestamp;
        task.lastInteraction = block.timestamp;
        task.requester = msg.sender;
        task.minPrice = _minPrice;
        task.maxPrice = msg.value;
        task.requesterDeposit = msg.value;

        taskHashes.push(hashTaskState(task));
        uint256 taskID = taskHashes.length - 1;

        emit MetaEvidence(taskID, _metaEvidence);
        emit TaskCreated(taskID, task.requester);
        emit TaskStateUpdated(taskID, task);

        return taskID;
    }

    /**
     * @dev Assigns a specific task to the sender.
     * Requires a translator deposit.
     * @param _taskID The ID of the task.
     * @param _task The task state.
     */
    function assignTask(uint256 _taskID, Task memory _task) public payable onlyValidTask(_taskID, _task) {
        require(block.timestamp - _task.lastInteraction <= _task.submissionTimeout, "Deadline has passed");
        require(_task.status == Status.Created, "Invalid task status");

        uint256 price = (_task.minPrice +
            ((_task.maxPrice - _task.minPrice) * (block.timestamp - _task.lastInteraction)) /
            _task.submissionTimeout);
        uint256 arbitrationCost = arbitrator.arbitrationCost(arbitratorExtraData);
        uint256 translatorDeposit = (
            arbitrationCost.addCap((translationMultiplier.mulCap(price)) / MULTIPLIER_DIVISOR)
        );

        require(msg.value >= translatorDeposit, "Deposit value too low");

        _task.parties[uint256(Party.Translator)] = msg.sender;
        _task.status = Status.Assigned;

        // Update requester's deposit since we reimbursed him the difference between maximal and actual price.
        _task.requesterDeposit = price;
        _task.translatorDeposit = translatorDeposit;

        taskHashes[_taskID] = hashTaskState(_task);

        uint256 remainder = _task.maxPrice - price;
        _task.requester.send(remainder);

        remainder = msg.value - translatorDeposit;
        msg.sender.send(remainder);

        emit TaskAssigned(_taskID, msg.sender, price);
        emit TaskStateUpdated(_taskID, _task);
    }

    /**
     * @dev Submits the translated text for a specific task.
     * @param _taskID The ID of the task.
     * @param _task The task state.
     * @param _translatedText The URI to the translated text.
     */
    function submitTranslation(
        uint256 _taskID,
        Task memory _task,
        string calldata _translatedText
    ) public onlyValidTask(_taskID, _task) {
        require(_task.status == Status.Assigned, "Invalid task status");
        require(block.timestamp - _task.lastInteraction <= _task.submissionTimeout, "Deadline has passed");
        require(msg.sender == _task.parties[uint256(Party.Translator)], "Only translator is allowed");

        _task.status = Status.InReview;
        _task.lastInteraction = block.timestamp;

        taskHashes[_taskID] = hashTaskState(_task);

        emit TranslationSubmitted(_taskID, msg.sender, _translatedText);
        emit TaskStateUpdated(_taskID, _task);
    }

    /**
     * @dev Reimburses the requester if no one picked the task or the translator failed to submit the translation before deadline.
     * @param _taskID The ID of the task.
     * @param _task The task state.
     */
    function reimburseRequester(uint256 _taskID, Task memory _task) public onlyValidTask(_taskID, _task) {
        require(_task.status < Status.InReview, "Translation was delivered");
        require(block.timestamp - _task.lastInteraction > _task.submissionTimeout, "Deadline has not passed");

        // Requester gets his deposit back and also the deposit of the translator, if there was one.
        uint256 amount = _task.requesterDeposit + _task.translatorDeposit;

        _task.status = Status.Resolved;
        _task.requesterDeposit = 0;
        _task.translatorDeposit = 0;

        taskHashes[_taskID] = hashTaskState(_task);

        _task.requester.send(amount);

        emit TaskResolved(_taskID, "requester-reimbursed");
        emit TaskStateUpdated(_taskID, _task);
    }

    /**
     * @dev Pays the translator for completed task if no one challenged the translation during review period.
     * @param _taskID The ID of the task.
     * @param _task The task state.
     */
    function acceptTranslation(uint256 _taskID, Task memory _task) public onlyValidTask(_taskID, _task) {
        require(_task.status == Status.InReview, "Invalid task status");
        require(block.timestamp - _task.lastInteraction > reviewTimeout, "Still in review period");

        // Translator gets the price of the task and his deposit back.
        uint256 amount = _task.requesterDeposit + _task.translatorDeposit;

        _task.status = Status.Resolved;
        _task.requesterDeposit = 0;
        _task.translatorDeposit = 0;

        taskHashes[_taskID] = hashTaskState(_task);

        _task.parties[uint256(Party.Translator)].send(amount);

        emit TaskResolved(_taskID, "translation-accepted");
        emit TaskStateUpdated(_taskID, _task);
    }

    /**
     * @dev Challenges the translation of a specific task. Requires challenger's deposit.
     * @param _taskID The ID of the task.
     * @param _task The task state.
     * @param _evidence A link to evidence using its URI. Ignored if not provided.
     */
    function challengeTranslation(
        uint256 _taskID,
        Task memory _task,
        string calldata _evidence
    ) public payable onlyValidTask(_taskID, _task) {
        uint256 arbitrationCost = arbitrator.arbitrationCost(arbitratorExtraData);

        require(_task.status == Status.InReview, "Invalid task status");
        require(block.timestamp - _task.lastInteraction <= reviewTimeout, "Review period has passed");
        require(msg.value >= arbitrationCost, "Deposit value too low");

        _task.status = Status.InDispute;
        _task.parties[uint256(Party.Challenger)] = msg.sender;
        _task.disputeID = arbitrator.createDispute{value: arbitrationCost}(2, arbitratorExtraData);

        taskHashes[_taskID] = hashTaskState(_task);

        taskDisputesByDisputeID[_task.disputeID].exists = true;
        taskDisputesByDisputeID[_task.disputeID].taskID = _taskID;

        roundsByTaskID[_taskID].push();

        uint256 remainder = msg.value - arbitrationCost;
        msg.sender.send(remainder);

        emit Dispute(arbitrator, _task.disputeID, _taskID, _taskID);
        emit TranslationChallenged(_taskID, msg.sender);
        emit TaskStateUpdated(_taskID, _task);

        if (bytes(_evidence).length > 0) {
            emit Evidence(arbitrator, _taskID, msg.sender, _evidence);
        }
    }

    /**
     * @dev Registers an evidence submission.
     * @param _taskID A task evidence is submitted for.
     * @param _task The task state.
     * @param _evidence A link to evidence using its URI.
     */
    function submitEvidence(
        uint256 _taskID,
        Task memory _task,
        string calldata _evidence
    ) public onlyValidTask(_taskID, _task) {
        /**
         * @notice When `rule` was called, but `executeRuling` was not yet,
         * the task is still in InDispute status, but the dispute is already settled.
         */
        require(taskDisputesByDisputeID[_task.disputeID].hasRuling == false, "Dispute already settled");

        emit Evidence(arbitrator, _taskID, msg.sender, _evidence);
    }

    /**
     * @dev Takes up to the total amount required to fund a side of an appeal.
     * @notice Reimburses the rest.
     * @notice Creates an appeal if both sides are fully funded.
     * @param _taskID The ID of challenged task.
     * @param _task The task state.
     * @param _side The party that pays the appeal fee.
     */
    function fundAppeal(
        uint256 _taskID,
        Task memory _task,
        Party _side
    ) public payable onlyValidTask(_taskID, _task) {
        require(_side == Party.Translator || _side == Party.Challenger, "Invalid side");
        require(_task.status == Status.InDispute, "No dispute to appeal");
        require(
            arbitrator.disputeStatus(_task.disputeID) == IArbitrator.DisputeStatus.Appealable,
            "Dispute is not appealable"
        );

        (uint256 appealPeriodStart, uint256 appealPeriodEnd) = arbitrator.appealPeriod(_task.disputeID);
        require(block.timestamp >= appealPeriodStart && block.timestamp < appealPeriodEnd, "Appeal period is over");

        uint256 winner = arbitrator.currentRuling(_task.disputeID);
        uint256 multiplier;
        if (winner == uint256(_side)) {
            multiplier = winnerStakeMultiplier;
        } else if (winner == 0) {
            multiplier = sharedStakeMultiplier;
        } else {
            require(
                block.timestamp - appealPeriodStart < (appealPeriodEnd - appealPeriodStart) / 2,
                "1st half appeal period is over"
            );
            multiplier = loserStakeMultiplier;
        }

        Round storage round = roundsByTaskID[_taskID][roundsByTaskID[_taskID].length - 1];
        require(!round.hasPaid[uint256(_side)], "Appeal fee already paid");

        uint256 appealCost = arbitrator.appealCost(_task.disputeID, arbitratorExtraData);
        uint256 totalCost = appealCost.addCap((appealCost.mulCap(multiplier)) / MULTIPLIER_DIVISOR);

        // Take up to the amount necessary to fund the current round at the current costs.
        uint256 contribution; // Amount contributed.
        uint256 remainingETH; // Remaining ETH to send back.
        (contribution, remainingETH) = calculateContribution(
            msg.value,
            totalCost.subCap(round.paidFees[uint256(_side)])
        );
        round.contributions[msg.sender][uint256(_side)] += contribution;
        round.paidFees[uint256(_side)] += contribution;

        emit AppealFeeContribution(_taskID, _side, msg.sender, contribution);

        // Add contribution to reward when the fee funding is successful, otherwise it can be withdrawn later.
        if (round.paidFees[uint256(_side)] >= totalCost) {
            round.hasPaid[uint256(_side)] = true;
            round.feeRewards += round.paidFees[uint256(_side)];

            emit AppealFeePaid(_taskID, _side);
        }

        // Create an appeal if both sides are funded.
        if (round.hasPaid[uint256(Party.Translator)] && round.hasPaid[uint256(Party.Challenger)]) {
            round.feeRewards = round.feeRewards.subCap(appealCost);
            roundsByTaskID[_taskID].push();

            arbitrator.appeal{value: appealCost}(_task.disputeID, arbitratorExtraData);
        }

        // Reimburse leftover ETH.
        msg.sender.send(remainingETH); // Deliberate use of send in order to not block the contract in case of reverting fallback.
    }

    /**
     * @dev Returns the contribution value and remainder from available ETH and required amount.
     * @param _available The amount of ETH available for the contribution.
     * @param _requiredAmount The amount of ETH required for the contribution.
     * @return taken The amount of ETH taken.
     * @return remainder The amount of ETH left from the contribution.
     */
    function calculateContribution(uint256 _available, uint256 _requiredAmount)
        internal
        pure
        returns (uint256 taken, uint256 remainder)
    {
        if (_requiredAmount > _available) {
            // Take whatever is available, return 0 as leftover ETH.
            return (_available, 0);
        }

        remainder = _available - _requiredAmount;
        return (_requiredAmount, remainder);
    }

    /**
     * @dev Registers a ruling for a dispute. Can only be called by the arbitrator.
     * @notice Ruling 0 is reserved for "Refused to Rule".
     * @param _disputeID ID of the dispute in the Arbitrator contract.
     * @param _ruling Ruling given by the arbitrator.
     */
    function rule(uint256 _disputeID, uint256 _ruling) public override {
        require(msg.sender == address(arbitrator), "Only arbitrator allowed");

        TaskDispute storage taskDispute = taskDisputesByDisputeID[_disputeID];
        require(taskDispute.exists, "Dispute does not exist");
        require(taskDispute.hasRuling == false, "Dispute already settled");

        Round[] storage rounds = roundsByTaskID[taskDispute.taskID];
        Round storage round = rounds[rounds.length - 1];

        /**
         * @notice If only one side paid its fees, we assume the ruling to be in its favor.
         * It is not possible for a round to have both sides paying the full fees AND
         * being the latest round at the same time.
         * When the last party pays its fees, a new round is automatically created.
         */
        if (round.hasPaid[uint256(Party.Translator)] == true) {
            taskDispute.ruling = uint256(Party.Translator);
        } else if (round.hasPaid[uint256(Party.Challenger)] == true) {
            taskDispute.ruling = uint256(Party.Challenger);
        } else {
            taskDispute.ruling = _ruling;
        }

        taskDispute.hasRuling = true;

        emit Ruling(arbitrator, _disputeID, taskDispute.ruling);
    }

    /**
     * @dev Effectively executes the ruling given by the arbitrator for a task.
     * @param _taskID The ID of the task.
     * @param _task The task state.
     */
    function executeRuling(uint256 _taskID, Task memory _task) public onlyValidTask(_taskID, _task) {
        require(_task.status == Status.InDispute, "Invalid task status");

        TaskDispute storage taskDispute = taskDisputesByDisputeID[_task.disputeID];
        require(taskDispute.hasRuling, "Arbitrator has not ruled yet");

        uint256 amount;
        uint256 requesterDeposit = _task.requesterDeposit;
        uint256 translatorDeposit = _task.translatorDeposit;

        _task.status = Status.Resolved;
        _task.ruling = taskDispute.ruling;
        _task.requesterDeposit = 0;
        _task.translatorDeposit = 0;

        taskHashes[_taskID] = hashTaskState(_task);

        if (taskDispute.ruling == uint256(Party.None)) {
            /**
             * @notice The value of `translatorDeposit` is split between the parties.
             * If the sum is uneven, the value of 1 wei will remain locked in the contract.
             */
            amount = translatorDeposit / 2;
            _task.parties[uint256(Party.Translator)].send(amount);
            _task.parties[uint256(Party.Challenger)].send(amount);
            _task.requester.send(requesterDeposit);
        } else if (taskDispute.ruling == uint256(Party.Translator)) {
            amount = requesterDeposit.addCap(translatorDeposit);
            _task.parties[uint256(Party.Translator)].send(amount);
        } else {
            _task.requester.send(requesterDeposit);
            _task.parties[uint256(Party.Challenger)].send(translatorDeposit);
        }

        emit TaskResolved(_taskID, "dispute-settled");
        emit TaskStateUpdated(_taskID, _task);
    }

    /**
     * @dev Withdraws contributions of multiple appeal rounds at once.
     * @notice This function is O(n) where n is the number of rounds. This could exceed the gas limit, therefore this function should be used only as a utility and not be relied upon by other contracts.
     * @param _taskID The ID of the associated task.
     * @param _task The task state.
     * @param _cursor The round from where to start withdrawing.
     * @param _count The number of rounds to iterate. If set to 0 or a value larger than the number of rounds, iterates until the last round.
     */
    function batchWithdrawFeesAndRewards(
        uint256 _taskID,
        Task memory _task,
        address payable _beneficiary,
        uint256 _cursor,
        uint256 _count
    ) public onlyValidTask(_taskID, _task) {
        require(_task.status == Status.Resolved, "The task should be resolved.");

        uint256 amount;
        for (uint256 i = _cursor; i < roundsByTaskID[_taskID].length && (_count == 0 || i < _cursor + _count); i++) {
            amount += registerWithdrawal(_taskID, _task, _beneficiary, i);
        }

        _beneficiary.send(amount); // It is the user responsibility to accept ETH.
    }

    /**
     * @dev Withdraws contributions of a specific appeal round.
     * @notice Reimburses contributions if no appeals were raised; otherwise sends the fee stake rewards and reimbursements proportional to the contributions made to the winner of a dispute.
     * @param _taskID The ID of the associated task.
     * @param _task The task state.
     * @param _beneficiary The address that made contributions.
     * @param _roundNumber The round from which to withdraw.
     * @return amount The withdrawn amount.
     */
    function withdrawFeesAndRewards(
        uint256 _taskID,
        Task memory _task,
        address payable _beneficiary,
        uint256 _roundNumber
    ) public onlyValidTask(_taskID, _task) returns (uint256 amount) {
        require(_task.status == Status.Resolved, "The task should be resolved.");

        amount = registerWithdrawal(_taskID, _task, _beneficiary, _roundNumber);

        _beneficiary.send(amount); // It is the user responsibility to accept ETH.
    }

    /**
     * @dev Register the withdrawal of fees and rewards for a given party in a given round.
     * @notice This function is internal because no checks are made on the task state. Caller functions MUST do the check before calling this function.
     * @param _taskID The ID of the associated task.
     * @param _task The task state.
     * @param _beneficiary The address that made contributions.
     * @param _roundNumber The round from which to withdraw.
     * @return amount The withdrawn amount.
     */
    function registerWithdrawal(
        uint256 _taskID,
        Task memory _task,
        address _beneficiary,
        uint256 _roundNumber
    ) internal returns (uint256 amount) {
        amount = getWithdrawableAmount(_taskID, _task, _beneficiary, _roundNumber);

        Round storage round = roundsByTaskID[_taskID][_roundNumber];
        round.contributions[_beneficiary][uint256(Party.Translator)] = 0;
        round.contributions[_beneficiary][uint256(Party.Challenger)] = 0;
    }

    /**
     * @dev Gets the number of tasks ever created in this contract.
     * @return The number of tasks.
     */
    function getNumberOfTasks() public view returns (uint256) {
        return taskHashes.length;
    }

    /**
     * @dev Gets the current price of a specified task.
     * @param _taskID The ID of the task.
     * @param _task The task state.
     * @return price The price of the task.
     */
    function getTaskPrice(uint256 _taskID, Task memory _task)
        public
        view
        onlyValidTask(_taskID, _task)
        returns (uint256)
    {
        if (block.timestamp - _task.lastInteraction > _task.submissionTimeout || _task.status != Status.Created) {
            return 0;
        } else {
            return
                _task.minPrice +
                ((_task.maxPrice - _task.minPrice) * (block.timestamp - _task.lastInteraction)) /
                _task.submissionTimeout;
        }
    }

    /**
     * @dev Gets the deposit required for self-assigning the task.
     * @param _taskID The ID of the task.
     * @param _task The task state.
     * @return The translator deposit.
     */
    function getTranslatorDeposit(uint256 _taskID, Task memory _task)
        public
        view
        onlyValidTask(_taskID, _task)
        returns (uint256)
    {
        if (block.timestamp - _task.lastInteraction > _task.submissionTimeout || _task.status != Status.Created) {
            return NON_PAYABLE_VALUE;
        } else {
            uint256 price = _task.minPrice +
                ((_task.maxPrice - _task.minPrice) * (block.timestamp - _task.lastInteraction)) /
                _task.submissionTimeout;
            uint256 arbitrationCost = arbitrator.arbitrationCost(arbitratorExtraData);
            return arbitrationCost.addCap((translationMultiplier.mulCap(price)) / MULTIPLIER_DIVISOR);
        }
    }

    /**
     * @dev Gets the deposit required for challenging the translation.
     * @param _taskID The ID of the task.
     * @param _task The task state.
     * @return The challenger deposit.
     */
    function getChallengerDeposit(uint256 _taskID, Task memory _task)
        public
        view
        onlyValidTask(_taskID, _task)
        returns (uint256)
    {
        if (block.timestamp - _task.lastInteraction > reviewTimeout || _task.status != Status.InReview) {
            return NON_PAYABLE_VALUE;
        } else {
            return arbitrator.arbitrationCost(arbitratorExtraData);
        }
    }

    /**
     * @dev Gets the number of rounds of the specific task.
     * @param _taskID The ID of the task.
     * @return The number of rounds.
     */
    function getNumberOfRounds(uint256 _taskID) public view returns (uint256) {
        return roundsByTaskID[_taskID].length;
    }

    /**
     * @dev Gets the information on a round of a task.
     * @param _taskID The ID of the task.
     * @param _roundNumber The round to be queried.
     * @return paidFees The amount of fees paid by each side.
     * @return hasPaid Whether each side has paid all the required appeal fees or not.
     * @return feeRewards The total amount of appeal fees to be used as crowdfunding rewards.
     */
    function getRoundInfo(uint256 _taskID, uint256 _roundNumber)
        public
        view
        returns (
            uint256[3] memory paidFees,
            bool[3] memory hasPaid,
            uint256 feeRewards
        )
    {
        Round memory round = roundsByTaskID[_taskID][_roundNumber];
        return (round.paidFees, round.hasPaid, round.feeRewards);
    }

    /**
     * @dev Gets the contributions made by a party for a given round of task appeal.
     * @param _taskID The ID of the task.
     * @param _contributor The address of the contributor.
     * @param _roundNumber The position of the round.
     * @return The contributions.
     */
    function getContributions(
        uint256 _taskID,
        address _contributor,
        uint256 _roundNumber
    ) public view returns (uint256[3] memory) {
        Round storage round = roundsByTaskID[_taskID][_roundNumber];
        return round.contributions[_contributor];
    }

    /**
     * @dev Returns the sum of withdrawable wei from appeal rounds. This function is O(n), where n is the number of rounds of the task. This could exceed the gas limit, therefore this function should only be used for interface display and not by other contracts.
     * @param _taskID The ID of the associated task.
     * @param _task The task state.
     * @param _beneficiary The contributor for which to query.
     * @return total The total amount of wei available to withdraw.
     */
    function getTotalWithdrawableAmount(
        uint256 _taskID,
        Task memory _task,
        address _beneficiary
    ) public view onlyValidTask(_taskID, _task) returns (uint256 total) {
        if (_task.status != Status.Resolved) {
            return total;
        }

        for (uint256 i = 0; i < roundsByTaskID[_taskID].length; i++) {
            total += getWithdrawableAmount(_taskID, _task, _beneficiary, i);
        }

        return total;
    }

    /**
     * @dev Returns the sum of withdrawable wei from a specific appeal round.
     * @notice This function is internal because no checks are made on the task state. Caller functions MUST do the check before calling this function.
     * @param _taskID The ID of the associated task.
     * @param _task The task state.
     * @param _beneficiary The contributor for which to query.
     * @param _roundNumber The number of the round.
     * @return The amount of wei available to withdraw from the round.
     */
    function getWithdrawableAmount(
        uint256 _taskID,
        Task memory _task,
        address _beneficiary,
        uint256 _roundNumber
    ) internal view returns (uint256) {
        Round storage round = roundsByTaskID[_taskID][_roundNumber];

        if (!round.hasPaid[uint256(Party.Translator)] || !round.hasPaid[uint256(Party.Challenger)]) {
            return
                round.contributions[_beneficiary][uint256(Party.Translator)] +
                round.contributions[_beneficiary][uint256(Party.Challenger)];
        } else if (_task.ruling == uint256(Party.None)) {
            uint256 rewardTranslator = round.paidFees[uint256(Party.Translator)] > 0
                ? (round.contributions[_beneficiary][uint256(Party.Translator)] * round.feeRewards) /
                    (round.paidFees[uint256(Party.Translator)] + round.paidFees[uint256(Party.Challenger)])
                : 0;
            uint256 rewardChallenger = round.paidFees[uint256(Party.Challenger)] > 0
                ? (round.contributions[_beneficiary][uint256(Party.Challenger)] * round.feeRewards) /
                    (round.paidFees[uint256(Party.Translator)] + round.paidFees[uint256(Party.Challenger)])
                : 0;

            return rewardTranslator + rewardChallenger;
        } else {
            return
                round.paidFees[_task.ruling] > 0
                    ? (round.contributions[_beneficiary][_task.ruling] * round.feeRewards) /
                        round.paidFees[_task.ruling]
                    : 0;
        }
    }

    /**
     * @dev Gets the hashed version of the task state.
     * @param _task The task state.
     * @return The hash of the task state.
     */
    function hashTaskState(Task memory _task) public pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    _task.status,
                    _task.requester,
                    _task.submissionTimeout,
                    _task.lastInteraction,
                    _task.minPrice,
                    _task.maxPrice,
                    _task.requesterDeposit,
                    _task.translatorDeposit,
                    _task.disputeID,
                    _task.ruling,
                    _task.parties
                )
            );
    }
}
