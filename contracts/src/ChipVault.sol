// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ChipVault
/// @notice Custodies tBNB backing the off-chain chip ledger for AgentHoldem.
/// @dev The chip ledger itself lives off-chain. This contract exists so that
///      deposits are observable as events rather than as bare transfers, which
///      removes the need to trust a client-supplied transaction hash. Solvency
///      is enforced by the operator, not by this contract.
contract ChipVault {
    /// @notice Address allowed to pay out redemptions and sweep fees.
    address public owner;

    /// @notice Address that has been nominated but has not yet accepted ownership.
    address public pendingOwner;

    /// @notice When true, new deposits are rejected. Payouts remain available.
    bool public depositsPaused;

    /// @notice Smallest accepted deposit, in wei. Blocks dust that costs more to index than it is worth.
    uint256 public minDeposit;

    /// @notice Intent identifiers already consumed by a deposit.
    mapping(bytes32 intentId => bool used) public intentUsed;

    /// @notice Redemption identifiers already paid out.
    mapping(bytes32 redemptionId => bool paid) public redemptionPaid;

    event Deposited(address indexed payer, bytes32 indexed intentId, uint256 amount);
    event PaidOut(address indexed recipient, bytes32 indexed redemptionId, uint256 amount);
    event Swept(address indexed recipient, uint256 amount);
    event Funded(address indexed sender, uint256 amount);
    event DepositsPausedSet(bool paused);
    event MinDepositSet(uint256 minDeposit);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotPendingOwner();
    error DepositsArePaused();
    error DepositTooSmall(uint256 sent, uint256 required);
    error IntentAlreadyUsed(bytes32 intentId);
    error RedemptionAlreadyPaid(bytes32 redemptionId);
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientBalance(uint256 requested, uint256 available);
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address initialOwner, uint256 initialMinDeposit) {
        if (initialOwner == address(0)) revert ZeroAddress();
        owner = initialOwner;
        minDeposit = initialMinDeposit;
        emit OwnershipTransferred(address(0), initialOwner);
        emit MinDepositSet(initialMinDeposit);
    }

    /// @notice Deposit tBNB against an intent issued by the operator.
    /// @param intentId Opaque identifier the operator issued to this player before the deposit.
    /// @dev The operator must still check that `payer` matches the address the intent was issued
    ///      to. Consuming the intent here only guarantees a single credit per identifier.
    function deposit(bytes32 intentId) external payable {
        if (depositsPaused) revert DepositsArePaused();
        if (msg.value < minDeposit) revert DepositTooSmall(msg.value, minDeposit);
        if (intentUsed[intentId]) revert IntentAlreadyUsed(intentId);

        intentUsed[intentId] = true;
        emit Deposited(msg.sender, intentId, msg.value);
    }

    /// @notice Pay a redemption out to a player. Amount is net of the operator's fee.
    /// @param redemptionId Identifier of the redemption record in the off-chain ledger.
    function payout(address recipient, uint256 amount, bytes32 redemptionId) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (redemptionPaid[redemptionId]) revert RedemptionAlreadyPaid(redemptionId);
        if (amount > address(this).balance) revert InsufficientBalance(amount, address(this).balance);

        redemptionPaid[redemptionId] = true;
        emit PaidOut(recipient, redemptionId, amount);

        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Withdraw accumulated fees. Solvency of the remaining float is the operator's responsibility.
    function sweep(address recipient, uint256 amount) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > address(this).balance) revert InsufficientBalance(amount, address(this).balance);

        emit Swept(recipient, amount);

        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Top the vault up without crediting any player. Used to pre-fund payouts.
    function fund() external payable {
        if (msg.value == 0) revert ZeroAmount();
        emit Funded(msg.sender, msg.value);
    }

    function setDepositsPaused(bool paused) external onlyOwner {
        depositsPaused = paused;
        emit DepositsPausedSet(paused);
    }

    function setMinDeposit(uint256 newMinDeposit) external onlyOwner {
        minDeposit = newMinDeposit;
        emit MinDepositSet(newMinDeposit);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previous = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, owner);
    }

    /// @dev Bare transfers are rejected so that every credit has an intent behind it.
    receive() external payable {
        revert("use deposit(bytes32)");
    }
}
