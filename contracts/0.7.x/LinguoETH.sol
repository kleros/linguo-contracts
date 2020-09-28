/**
 * @authors: [@hbarcelos]
 * @reviewers: []
 * @auditors: []
 * @bounties: []
 * @deployments: []
 *
 * SPDX-License-Identifier: MIT
 */

pragma solidity ^0.7.1;
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
     * @param _reason Short description of what caused the task to be solved.
     */
    event TaskResolved(uint256 indexed _taskID, ResolveReason _reason);

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

    enum ResolveReason {
        RequesterReimbursed, // Task was resolved after deadline has passed and a translation was not delivered.
        TranslationAccepted, // Task was resolved because the translated task was not challenged.
        DisputeSettled // Task was resolved after the challenge dispute had been settled.
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
        uint256 minPrice; // Minimum price for the translation. When the task is created it has minimal price that gradually increases such as it reaches maximal price at deadline.
        uint256 maxPrice; // Maximum price for the translation and also value that must be deposited by the requester.
        uint256 requesterDeposit; // The deposit requester makes when creating the task. Once a task is assigned this deposit will be partially reimbursed and its value replaced by task price.
        uint256 translatorDeposit; // The deposit of the translator, if any. This value will be paid to the party that wins the dispute.
        uint256 disputeID; // The ID of the dispute created in arbitrator contract.
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

    /// @dev Stores all tasks created in the contract.
    Task[] public tasks;

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
    ) {
        governor = msg.sender;
        arbitrator = _arbitrator;
        arbitratorExtraData = _arbitratorExtraData;
        reviewTimeout = _reviewTimeout;
        translationMultiplier = _translationMultiplier;
        sharedStakeMultiplier = _sharedStakeMultiplier;
        winnerStakeMultiplier = _winnerStakeMultiplier;
        loserStakeMultiplier = _loserStakeMultiplier;
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
     * @return The ID of the created task.
     */
    function createTask(
        uint256 _deadline,
        uint256 _minPrice,
        string calldata _metaEvidence
    ) external payable returns (uint256) {
        require(msg.value >= _minPrice, "Deposit value too low");
        require(_deadline > block.timestamp, "Deadline must be in the future");

        Task storage task = tasks.push();

        task.submissionTimeout = _deadline - block.timestamp;
        task.lastInteraction = block.timestamp;
        task.requester = msg.sender;
        task.minPrice = _minPrice;
        task.maxPrice = msg.value;
        task.requesterDeposit = msg.value;

        uint256 taskID = tasks.length - 1;

        emit MetaEvidence(taskID, _metaEvidence);
        emit TaskCreated(taskID, msg.sender);

        return taskID;
    }

    /**
     * @dev Assigns a specific task to the sender.
     * Requires a translator deposit.
     * @param _taskID The ID of the task.
     */
    function assignTask(uint256 _taskID) external payable {
        Task storage task = tasks[_taskID];

        require(block.timestamp - task.lastInteraction <= task.submissionTimeout, "Deadline has passed");
        require(task.status == Status.Created, "Invalid task status");

        uint256 price = (task.minPrice +
            ((task.maxPrice - task.minPrice) * (block.timestamp - task.lastInteraction)) /
            task.submissionTimeout);
        uint256 arbitrationCost = arbitrator.arbitrationCost(arbitratorExtraData);
        uint256 translatorDeposit = (
            arbitrationCost.addCap((translationMultiplier.mulCap(price)) / MULTIPLIER_DIVISOR)
        );

        require(msg.value >= translatorDeposit, "Deposit value too low");

        task.parties[uint256(Party.Translator)] = msg.sender;
        task.status = Status.Assigned;

        // Update requester's deposit since we reimbursed him the difference between maximal and actual price.
        task.requesterDeposit = price;
        task.translatorDeposit = translatorDeposit;

        uint256 remainder = task.maxPrice - price;
        task.requester.send(remainder);

        remainder = msg.value - translatorDeposit;
        msg.sender.send(remainder);

        emit TaskAssigned(_taskID, msg.sender, price);
    }

    /**
     * @dev Submits the translated text for a specific task.
     * @param _taskID The ID of the task.
     * @param _translatedText The URI to the translated text.
     */
    function submitTranslation(uint256 _taskID, string calldata _translatedText) external {
        Task storage task = tasks[_taskID];

        require(task.status == Status.Assigned, "Invalid task status");
        require(block.timestamp - task.lastInteraction <= task.submissionTimeout, "Deadline has passed");
        require(msg.sender == task.parties[uint256(Party.Translator)], "Only translator is allowed");

        task.status = Status.InReview;
        task.lastInteraction = block.timestamp;

        emit TranslationSubmitted(_taskID, msg.sender, _translatedText);
    }

    /**
     * @dev Reimburses the requester if no one picked the task or the translator failed to submit the translation before deadline.
     * @param _taskID The ID of the task.
     */
    function reimburseRequester(uint256 _taskID) external {
        Task storage task = tasks[_taskID];

        require(task.status < Status.InReview, "Translation was delivered");
        require(block.timestamp - task.lastInteraction > task.submissionTimeout, "Deadline has not passed");

        // Requester gets his deposit back and also the deposit of the translator, if there was one.
        uint256 amount = task.requesterDeposit + task.translatorDeposit;

        task.status = Status.Resolved;
        task.requesterDeposit = 0;
        task.translatorDeposit = 0;

        task.requester.send(amount);

        emit TaskResolved(_taskID, ResolveReason.RequesterReimbursed);
    }

    /**
     * @dev Pays the translator for completed task if no one challenged the translation during review period.
     * @param _taskID The ID of the task.
     */
    function acceptTranslation(uint256 _taskID) external {
        Task storage task = tasks[_taskID];

        require(task.status == Status.InReview, "Invalid task status");
        require(block.timestamp - task.lastInteraction > reviewTimeout, "Still in review period");

        // Translator gets the price of the task and his deposit back.
        uint256 amount = task.requesterDeposit + task.translatorDeposit;

        task.status = Status.Resolved;
        task.requesterDeposit = 0;
        task.translatorDeposit = 0;

        task.parties[uint256(Party.Translator)].send(amount);

        emit TaskResolved(_taskID, ResolveReason.TranslationAccepted);
    }

    /**
     * @dev Challenges the translation of a specific task. Requires challenger's deposit.
     * @param _taskID The ID of the task.
     * @param _evidence A link to evidence using its URI. Ignored if not provided.
     */
    function challengeTranslation(uint256 _taskID, string calldata _evidence) external payable {
        Task storage task = tasks[_taskID];
        uint256 arbitrationCost = arbitrator.arbitrationCost(arbitratorExtraData);

        require(task.status == Status.InReview, "Invalid task status");
        require(block.timestamp - task.lastInteraction <= reviewTimeout, "Review period has passed");
        require(msg.value >= arbitrationCost, "Deposit value too low");

        task.status = Status.InDispute;
        task.parties[uint256(Party.Challenger)] = msg.sender;
        task.disputeID = arbitrator.createDispute{value: arbitrationCost}(2, arbitratorExtraData);

        taskDisputesByDisputeID[task.disputeID].exists = true;
        taskDisputesByDisputeID[task.disputeID].taskID = _taskID;

        roundsByTaskID[_taskID].push();

        uint256 remainder = msg.value - arbitrationCost;
        msg.sender.send(remainder);

        emit Dispute(arbitrator, task.disputeID, _taskID, _taskID);
        emit TranslationChallenged(_taskID, msg.sender);

        if (bytes(_evidence).length > 0) {
            emit Evidence(arbitrator, _taskID, msg.sender, _evidence);
        }
    }

    /**
     * @dev Registers an evidence submission.
     * @param _taskID A task evidence is submitted for.
     * @param _evidence A link to evidence using its URI.
     */
    function submitEvidence(uint256 _taskID, string calldata _evidence) external {
        Task storage task = tasks[_taskID];

        require(taskDisputesByDisputeID[task.disputeID].hasRuling == false, "Dispute already settled");

        emit Evidence(arbitrator, _taskID, msg.sender, _evidence);
    }

    /**
     * @dev Takes up to the total amount required to fund a side of an appeal.
     * @notice Reimburses the rest.
     * @notice Creates an appeal if both sides are fully funded.
     * @param _taskID The ID of challenged task.
     * @param _side The party that pays the appeal fee.
     */
    function fundAppeal(uint256 _taskID, Party _side) external payable {
        Task storage task = tasks[_taskID];

        require(_side == Party.Translator || _side == Party.Challenger, "Invalid side");
        require(task.status == Status.InDispute, "No dispute to appeal");
        require(
            arbitrator.disputeStatus(task.disputeID) == IArbitrator.DisputeStatus.Appealable,
            "Dispute is not appealable"
        );

        (uint256 appealPeriodStart, uint256 appealPeriodEnd) = arbitrator.appealPeriod(task.disputeID);
        require(block.timestamp >= appealPeriodStart && block.timestamp < appealPeriodEnd, "Appeal period is over");

        uint256 winner = arbitrator.currentRuling(task.disputeID);
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

        uint256 appealCost = arbitrator.appealCost(task.disputeID, arbitratorExtraData);
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

            arbitrator.appeal{value: appealCost}(task.disputeID, arbitratorExtraData);
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
        private
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

        executeRuling(taskDispute.taskID, taskDispute.ruling);
    }

    /**
     * @dev Effectively executes the ruling given by the arbitrator for a task.
     * @param _taskID The ID of the task.
     * @param _ruling The ruling from the arbitrator.
     */
    function executeRuling(uint256 _taskID, uint256 _ruling) private {
        Task storage task = tasks[_taskID];

        uint256 amount;
        uint256 requesterDeposit = task.requesterDeposit;
        uint256 translatorDeposit = task.translatorDeposit;

        task.status = Status.Resolved;
        task.requesterDeposit = 0;
        task.translatorDeposit = 0;

        if (_ruling == uint256(Party.None)) {
            /**
             * @notice The value of `translatorDeposit` is split between the parties.
             * If the sum is uneven, the value of 1 wei will remain locked in the contract.
             */
            amount = translatorDeposit / 2;
            task.parties[uint256(Party.Translator)].send(amount);
            task.parties[uint256(Party.Challenger)].send(amount);
            task.requester.send(requesterDeposit);
        } else if (_ruling == uint256(Party.Translator)) {
            amount = requesterDeposit.addCap(translatorDeposit);
            task.parties[uint256(Party.Translator)].send(amount);
        } else {
            task.requester.send(requesterDeposit);
            task.parties[uint256(Party.Challenger)].send(translatorDeposit);
        }

        emit TaskResolved(_taskID, ResolveReason.DisputeSettled);
    }

    /**
     * @dev Withdraws contributions of multiple appeal rounds at once.
     * @notice This function is O(n) where n is the number of rounds. This could exceed the gas limit, therefore this function should be used only as a utility and not be relied upon by other contracts.
     * @param _taskID The ID of the associated task.
     * @param _cursor The round from where to start withdrawing.
     * @param _count The number of rounds to iterate. If set to 0 or a value larger than the number of rounds, iterates until the last round.
     */
    function batchWithdrawFeesAndRewards(
        uint256 _taskID,
        address payable _beneficiary,
        uint256 _cursor,
        uint256 _count
    ) external {
        Task storage task = tasks[_taskID];
        TaskDispute storage taskDispute = taskDisputesByDisputeID[task.disputeID];

        require(task.status == Status.Resolved, "The task should be resolved.");
        require(_taskID == taskDispute.taskID, "Task has no dispute.");

        uint256 amount;
        for (uint256 i = _cursor; i < roundsByTaskID[_taskID].length && (_count == 0 || i < _cursor + _count); i++) {
            amount += registerWithdrawal(_taskID, _beneficiary, i);
        }

        _beneficiary.send(amount); // It is the user responsibility to accept ETH.
    }

    /**
     * @dev Withdraws contributions of a specific appeal round.
     * @notice Reimburses contributions if no appeals were raised; otherwise sends the fee stake rewards and reimbursements proportional to the contributions made to the winner of a dispute.
     * @param _taskID The ID of the associated task.
     * @param _beneficiary The address that made contributions.
     * @param _roundNumber The round from which to withdraw.
     * @return amount The withdrawn amount.
     */
    function withdrawFeesAndRewards(
        uint256 _taskID,
        address payable _beneficiary,
        uint256 _roundNumber
    ) external returns (uint256 amount) {
        Task storage task = tasks[_taskID];
        TaskDispute storage taskDispute = taskDisputesByDisputeID[task.disputeID];

        require(task.status == Status.Resolved, "The task should be resolved.");
        require(_taskID == taskDispute.taskID, "Task has no dispute.");

        amount = registerWithdrawal(_taskID, _beneficiary, _roundNumber);

        _beneficiary.send(amount); // It is the user responsibility to accept ETH.
    }

    /**
     * @dev Register the withdrawal of fees and rewards for a given party in a given round.
     * @notice This function is private because no checks are made on the task state. Caller functions MUST do the check before calling this function.
     * @param _taskID The ID of the associated task.
     * @param _beneficiary The address that made contributions.
     * @param _roundNumber The round from which to withdraw.
     * @return amount The withdrawn amount.
     */
    function registerWithdrawal(
        uint256 _taskID,
        address _beneficiary,
        uint256 _roundNumber
    ) private returns (uint256 amount) {
        amount = getWithdrawableAmount(_taskID, _beneficiary, _roundNumber);

        Round storage round = roundsByTaskID[_taskID][_roundNumber];
        round.contributions[_beneficiary][uint256(Party.Translator)] = 0;
        round.contributions[_beneficiary][uint256(Party.Challenger)] = 0;
    }

    /**
     * @dev Gets a given task details.
     * @return The task details.
     */
    function getTask(uint256 _taskID) external view returns (Task memory) {
        return tasks[_taskID];
    }

    /**
     * @dev Gets the number of tasks ever created in this contract.
     * @return The number of tasks.
     */
    function getNumberOfTasks() external view returns (uint256) {
        return tasks.length;
    }

    /**
     * @dev Gets the current price of a specified task.
     * @param _taskID The ID of the task.
     * @return price The price of the task.
     */
    function getTaskPrice(uint256 _taskID) external view returns (uint256) {
        Task storage task = tasks[_taskID];
        if (block.timestamp - task.lastInteraction > task.submissionTimeout || task.status != Status.Created) {
            return 0;
        } else {
            return
                task.minPrice +
                ((task.maxPrice - task.minPrice) * (block.timestamp - task.lastInteraction)) /
                task.submissionTimeout;
        }
    }

    /**
     * @dev Gets the deposit required for self-assigning the task.
     * @param _taskID The ID of the task.
     * @return The translator deposit.
     */
    function getTranslatorDeposit(uint256 _taskID) external view returns (uint256) {
        Task storage task = tasks[_taskID];
        if (block.timestamp - task.lastInteraction > task.submissionTimeout || task.status != Status.Created) {
            return NON_PAYABLE_VALUE;
        } else {
            uint256 price = task.minPrice +
                ((task.maxPrice - task.minPrice) * (block.timestamp - task.lastInteraction)) /
                task.submissionTimeout;
            uint256 arbitrationCost = arbitrator.arbitrationCost(arbitratorExtraData);
            return arbitrationCost.addCap((translationMultiplier.mulCap(price)) / MULTIPLIER_DIVISOR);
        }
    }

    /**
     * @dev Gets the deposit required for challenging the translation.
     * @param _taskID The ID of the task.
     * @return The challenger deposit.
     */
    function getChallengerDeposit(uint256 _taskID) external view returns (uint256) {
        Task storage task = tasks[_taskID];
        if (block.timestamp - task.lastInteraction > reviewTimeout || task.status != Status.InReview) {
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
    function getNumberOfRounds(uint256 _taskID) external view returns (uint256) {
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
        external
        view
        returns (
            uint256[3] memory paidFees,
            bool[3] memory hasPaid,
            uint256 feeRewards
        )
    {
        Round storage round = roundsByTaskID[_taskID][_roundNumber];
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
    ) external view returns (uint256[3] memory) {
        Round storage round = roundsByTaskID[_taskID][_roundNumber];
        return round.contributions[_contributor];
    }

    /**
     * @dev Returns the sum of withdrawable wei from appeal rounds. This function is O(n), where n is the number of rounds of the task. This could exceed the gas limit, therefore this function should only be used for interface display and not by other contracts.
     * @param _taskID The ID of the associated task.
     * @param _beneficiary The contributor for which to query.
     * @return total The total amount of wei available to withdraw.
     */
    function getTotalWithdrawableAmount(uint256 _taskID, address _beneficiary) external view returns (uint256 total) {
        Task storage task = tasks[_taskID];
        if (task.status != Status.Resolved) {
            return total;
        }

        for (uint256 i = 0; i < roundsByTaskID[_taskID].length; i++) {
            total += getWithdrawableAmount(_taskID, _beneficiary, i);
        }

        return total;
    }

    /**
     * @dev Returns the sum of withdrawable wei from a specific appeal round.
     * @notice This function is private because no checks are made on the task state. Caller functions MUST do the check before calling this function.
     * @param _taskID The ID of the associated task.
     * @param _beneficiary The contributor for which to query.
     * @param _roundNumber The number of the round.
     * @return The amount of wei available to withdraw from the round.
     */
    function getWithdrawableAmount(
        uint256 _taskID,
        address _beneficiary,
        uint256 _roundNumber
    ) private view returns (uint256) {
        Task storage task = tasks[_taskID];
        TaskDispute storage taskDispute = taskDisputesByDisputeID[task.disputeID];
        Round storage round = roundsByTaskID[_taskID][_roundNumber];

        if (!round.hasPaid[uint256(Party.Translator)] || !round.hasPaid[uint256(Party.Challenger)]) {
            return
                round.contributions[_beneficiary][uint256(Party.Translator)] +
                round.contributions[_beneficiary][uint256(Party.Challenger)];
        } else if (taskDispute.ruling == uint256(Party.None)) {
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
                round.paidFees[taskDispute.ruling] > 0
                    ? (round.contributions[_beneficiary][taskDispute.ruling] * round.feeRewards) /
                        round.paidFees[taskDispute.ruling]
                    : 0;
        }
    }
}
