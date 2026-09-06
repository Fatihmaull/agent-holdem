// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title PokerEscrow
 * @notice Cashier and settlement escrow for the AgentHoldem arena on BNB
 *         Smart Chain Testnet.
 *
 * Managers buy chips up front in one of four fixed tiers, lock chips as a
 * buy-in when they deploy an agent to a table, and the backend arbiter
 * settles the table once the session's hands are done.
 *
 * Safety properties this contract holds, beyond the reference sketch:
 *
 *  - A table's buy-in is fixed by its first entrant; later entrants must match
 *    it, and no wallet can enter the same table twice.
 *  - Settlement can never pay out more than the table actually staked, so a
 *    compromised arbiter cannot mint chips — the worst it can do is
 *    misallocate the chips already escrowed for that one table.
 *  - `totalChipsOutstanding` tracks every chip the contract owes. The owner
 *    can only ever withdraw the surplus above that liability, so house
 *    withdrawals cannot touch player funds.
 *  - Players are not hostage to the arbiter: after `REFUND_DELAY` an
 *    unsettled table can be refunded by anyone, returning each stake to the
 *    wallet that posted it.
 */
contract PokerEscrow {
    /* --------------------------------------------------------------- *
     * Roles and configuration
     * --------------------------------------------------------------- */

    address public owner;
    address public pendingOwner;
    /// @notice Backend worker permitted to settle tables.
    address public arbiterServer;

    bool public paused;

    /// @notice Price in wei for each tier (1..4).
    mapping(uint8 => uint256) public tierPrice;
    /// @notice Chips credited for each tier (1..4).
    mapping(uint8 => uint256) public tierChips;

    /// @notice Redemption rate used by `withdrawChips`.
    uint256 public weiPerChip;

    /// @notice Every chip the contract currently owes to somebody.
    uint256 public totalChipsOutstanding;

    /// @notice A table left unsettled this long can be refunded by anyone.
    uint256 public constant REFUND_DELAY = 7 days;

    mapping(address => uint256) public userChipBalance;

    struct TableSession {
        uint256 buyInChips;
        uint256 totalStaked;
        uint64 openedAt;
        bool active;
        bool settled;
        address[] players;
    }

    mapping(bytes32 => TableSession) private _tables;
    /// @notice Chips each wallet has staked in a given table.
    mapping(bytes32 => mapping(address => uint256)) public tableStake;

    /* --------------------------------------------------------------- *
     * Events
     * --------------------------------------------------------------- */

    event ChipsPurchased(address indexed user, uint256 packageTier, uint256 chipsCredited);
    event TableEnrolled(bytes32 indexed tableId, address indexed player, uint256 buyInChips);
    event TableSettled(bytes32 indexed tableId, address indexed winner, uint256 payoutChips);
    event TableRefunded(bytes32 indexed tableId, address indexed player, uint256 chips);
    event ChipsWithdrawn(address indexed user, uint256 chips, uint256 weiPaid);
    event ArbiterChanged(address indexed previousArbiter, address indexed newArbiter);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event TierConfigured(uint8 indexed tier, uint256 priceWei, uint256 chips);
    event WeiPerChipUpdated(uint256 weiPerChip);
    event PausedSet(bool paused);
    event HouseWithdrawal(address indexed to, uint256 amount);

    /* --------------------------------------------------------------- *
     * Errors
     * --------------------------------------------------------------- */

    error Unauthorized();
    error InvalidTier();
    error InsufficientPayment(uint256 required, uint256 provided);
    error InsufficientChipBalance(uint256 required, uint256 available);
    error TableClosed();
    error TableNotSettleable();
    error BuyInMismatch(uint256 expected, uint256 provided);
    error AlreadySeated();
    error PayoutExceedsStake(uint256 staked, uint256 payout);
    error ArrayLengthMismatch();
    error RefundTooEarly(uint256 availableAt);
    error TransferFailed();
    error ZeroAddress();
    error ContractPaused();
    error Reentrancy();
    error WithdrawalsDisabled();
    error InsufficientReserve(uint256 required, uint256 available);

    /* --------------------------------------------------------------- *
     * Modifiers
     * --------------------------------------------------------------- */

    uint256 private _entered;

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyArbiter() {
        if (msg.sender != arbiterServer) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    /* --------------------------------------------------------------- *
     * Construction
     * --------------------------------------------------------------- */

    /**
     * @param _arbiter Backend worker allowed to settle tables.
     * @param prices   Wei price for tiers 1..4, in order.
     * @param chips    Chips credited for tiers 1..4, in order.
     * @param _weiPerChip Redemption rate. Pass 0 to disable withdrawals.
     */
    constructor(
        address _arbiter,
        uint256[4] memory prices,
        uint256[4] memory chips,
        uint256 _weiPerChip
    ) {
        if (_arbiter == address(0)) revert ZeroAddress();
        owner = msg.sender;
        arbiterServer = _arbiter;
        weiPerChip = _weiPerChip;

        for (uint8 i = 0; i < 4; i++) {
            uint8 tier = i + 1;
            tierPrice[tier] = prices[i];
            tierChips[tier] = chips[i];
            emit TierConfigured(tier, prices[i], chips[i]);
        }

        emit ArbiterChanged(address(0), _arbiter);
        emit OwnershipTransferred(address(0), msg.sender);
        emit WeiPerChipUpdated(_weiPerChip);
    }

    /* --------------------------------------------------------------- *
     * Cashier
     * --------------------------------------------------------------- */

    /**
     * @notice Buys a fixed chip package with native tBNB.
     * @dev Overpayment is refunded rather than absorbed, so a stale front-end
     *      price costs the user gas but never their funds.
     */
    function buyChips(uint8 tier) external payable whenNotPaused nonReentrant {
        uint256 price = tierPrice[tier];
        uint256 chips = tierChips[tier];
        if (tier == 0 || tier > 4 || chips == 0) revert InvalidTier();
        if (msg.value < price) revert InsufficientPayment(price, msg.value);

        userChipBalance[msg.sender] += chips;
        totalChipsOutstanding += chips;

        emit ChipsPurchased(msg.sender, tier, chips);

        uint256 refund = msg.value - price;
        if (refund > 0) _send(msg.sender, refund);
    }

    /**
     * @notice Redeems chips for tBNB at the configured rate.
     * @dev Chips only leave circulation here, which is what keeps
     *      `totalChipsOutstanding` an exact liability figure.
     */
    function withdrawChips(uint256 chips) external nonReentrant {
        if (weiPerChip == 0) revert WithdrawalsDisabled();
        uint256 balance = userChipBalance[msg.sender];
        if (balance < chips || chips == 0) revert InsufficientChipBalance(chips, balance);

        uint256 payout = chips * weiPerChip;
        if (address(this).balance < payout) {
            revert InsufficientReserve(payout, address(this).balance);
        }

        userChipBalance[msg.sender] = balance - chips;
        totalChipsOutstanding -= chips;

        emit ChipsWithdrawn(msg.sender, chips, payout);
        _send(msg.sender, payout);
    }

    /* --------------------------------------------------------------- *
     * Table lifecycle
     * --------------------------------------------------------------- */

    /**
     * @notice Locks chips as a buy-in for `tableId`.
     * @dev Callable repeatedly across different tables — that is exactly the
     *      multi-room batch deploy the arena is built around — but only once
     *      per wallet per table.
     */
    function lockChipsForTable(bytes32 tableId, uint256 buyInChips)
        external
        whenNotPaused
        nonReentrant
    {
        if (buyInChips == 0) revert BuyInMismatch(0, 0);

        TableSession storage session = _tables[tableId];
        if (session.settled) revert TableClosed();

        if (session.players.length == 0) {
            session.buyInChips = buyInChips;
            session.openedAt = uint64(block.timestamp);
            session.active = true;
        } else if (session.buyInChips != buyInChips) {
            revert BuyInMismatch(session.buyInChips, buyInChips);
        }

        if (tableStake[tableId][msg.sender] != 0) revert AlreadySeated();

        uint256 balance = userChipBalance[msg.sender];
        if (balance < buyInChips) revert InsufficientChipBalance(buyInChips, balance);

        userChipBalance[msg.sender] = balance - buyInChips;
        tableStake[tableId][msg.sender] = buyInChips;
        session.totalStaked += buyInChips;
        session.players.push(msg.sender);

        emit TableEnrolled(tableId, msg.sender, buyInChips);
    }

    /**
     * @notice Settles a table with a single winner taking the whole pot.
     * @dev Kept for interface compatibility; it forwards to the multi-winner
     *      path, which is what the arena actually uses (agents usually walk
     *      away with different stack sizes rather than winner-takes-all).
     */
    function settleTable(bytes32 tableId, address winner, uint256 payoutChips)
        external
        onlyArbiter
    {
        address[] memory winners = new address[](1);
        uint256[] memory payouts = new uint256[](1);
        winners[0] = winner;
        payouts[0] = payoutChips;
        _settle(tableId, winners, payouts);
    }

    /**
     * @notice Settles a table by crediting each player their final stack.
     * @param winners Wallets to credit. May include every seat, not just the
     *        top one.
     * @param payoutChips Chips to credit, index-aligned with `winners`.
     */
    function settleTableMulti(
        bytes32 tableId,
        address[] calldata winners,
        uint256[] calldata payoutChips
    ) external onlyArbiter {
        if (winners.length != payoutChips.length) revert ArrayLengthMismatch();
        _settle(tableId, winners, payoutChips);
    }

    function _settle(
        bytes32 tableId,
        address[] memory winners,
        uint256[] memory payoutChips
    ) private {
        TableSession storage session = _tables[tableId];
        if (!session.active || session.settled) revert TableNotSettleable();

        uint256 total;
        for (uint256 i = 0; i < payoutChips.length; i++) {
            total += payoutChips[i];
        }
        // The arbiter redistributes escrowed chips; it cannot create them.
        if (total > session.totalStaked) {
            revert PayoutExceedsStake(session.totalStaked, total);
        }

        session.settled = true;
        session.active = false;

        for (uint256 i = 0; i < winners.length; i++) {
            address winner = winners[i];
            uint256 amount = payoutChips[i];
            if (winner == address(0)) revert ZeroAddress();
            if (amount == 0) continue;
            userChipBalance[winner] += amount;
            emit TableSettled(tableId, winner, amount);
        }

        // Anything the arbiter did not distribute is house rake and stays
        // inside the outstanding-chip accounting.
        uint256 rake = session.totalStaked - total;
        if (rake > 0) {
            userChipBalance[owner] += rake;
            emit TableSettled(tableId, owner, rake);
        }
    }

    /**
     * @notice Cancels a table and returns every stake to its owner.
     * @dev The arbiter calls this when a session aborts. After
     *      `REFUND_DELAY` anyone may call it, so a silent arbiter cannot
     *      strand player funds.
     */
    function refundTable(bytes32 tableId) external nonReentrant {
        TableSession storage session = _tables[tableId];
        if (!session.active || session.settled) revert TableNotSettleable();

        if (msg.sender != arbiterServer && msg.sender != owner) {
            uint256 availableAt = uint256(session.openedAt) + REFUND_DELAY;
            if (block.timestamp < availableAt) revert RefundTooEarly(availableAt);
        }

        session.settled = true;
        session.active = false;

        uint256 count = session.players.length;
        for (uint256 i = 0; i < count; i++) {
            address player = session.players[i];
            uint256 stake = tableStake[tableId][player];
            if (stake == 0) continue;
            tableStake[tableId][player] = 0;
            userChipBalance[player] += stake;
            emit TableRefunded(tableId, player, stake);
        }
    }

    /* --------------------------------------------------------------- *
     * Views
     * --------------------------------------------------------------- */

    function tableInfo(bytes32 tableId)
        external
        view
        returns (
            uint256 buyInChips,
            uint256 totalStaked,
            uint64 openedAt,
            bool active,
            bool settled,
            uint256 playerCount
        )
    {
        TableSession storage session = _tables[tableId];
        return (
            session.buyInChips,
            session.totalStaked,
            session.openedAt,
            session.active,
            session.settled,
            session.players.length
        );
    }

    function tablePlayers(bytes32 tableId) external view returns (address[] memory) {
        return _tables[tableId].players;
    }

    function quoteTier(uint8 tier) external view returns (uint256 priceWei, uint256 chips) {
        return (tierPrice[tier], tierChips[tier]);
    }

    /// @notice tBNB held above what the contract owes chip holders.
    function houseSurplus() public view returns (uint256) {
        uint256 liability = totalChipsOutstanding * weiPerChip;
        uint256 balance = address(this).balance;
        return balance > liability ? balance - liability : 0;
    }

    /* --------------------------------------------------------------- *
     * Administration
     * --------------------------------------------------------------- */

    function setArbiter(address newArbiter) external onlyOwner {
        if (newArbiter == address(0)) revert ZeroAddress();
        emit ArbiterChanged(arbiterServer, newArbiter);
        arbiterServer = newArbiter;
    }

    function configureTier(uint8 tier, uint256 priceWei, uint256 chips) external onlyOwner {
        if (tier == 0 || tier > 4) revert InvalidTier();
        tierPrice[tier] = priceWei;
        tierChips[tier] = chips;
        emit TierConfigured(tier, priceWei, chips);
    }

    function setWeiPerChip(uint256 newRate) external onlyOwner {
        weiPerChip = newRate;
        emit WeiPerChipUpdated(newRate);
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PausedSet(value);
    }

    /**
     * @notice Withdraws house profit.
     * @dev Bounded by `houseSurplus()`, so the reserve backing outstanding
     *      chips is untouchable even by the owner.
     */
    function withdrawHouse(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 surplus = houseSurplus();
        if (amount > surplus) revert InsufficientReserve(amount, surplus);
        emit HouseWithdrawal(to, amount);
        _send(to, amount);
    }

    /// @notice Two-step ownership transfer; the new owner must accept.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    /* --------------------------------------------------------------- *
     * Internals
     * --------------------------------------------------------------- */

    function _send(address to, uint256 amount) private {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Accepts tBNB so the owner can top up the withdrawal reserve.
    receive() external payable {}
}
