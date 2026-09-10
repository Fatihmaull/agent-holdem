// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ChipVault
/// @notice Custodies the native token backing the off-chain chip ledger for AgentHoldem.
/// @dev One vault per chain, each holding only its own float. The chip ledger
///      itself lives off-chain and spans them. This contract exists so that
///      deposits are observable as events rather than as bare transfers, which
///      removes the need to trust a client-supplied transaction hash.
///
///      Chips are one-way. There is deliberately no function here that pays a
///      player, so a chip cannot be turned back into a token by this contract
///      under any caller, the operator included. Chips buy table time and a
///      place on the record, and that is the whole of what they are worth.
///      Making that a property of the deployed bytecode rather than a policy in
///      the application is the point: a policy can be changed by a deploy.
contract ChipVault {
    /// @notice Address allowed to sweep the vault and change its settings.
    address public owner;

    /// @notice Address that has been nominated but has not yet accepted ownership.
    address public pendingOwner;

    /// @notice When true, new deposits are rejected.
    bool public depositsPaused;

    /// @notice Smallest accepted deposit, in wei. Blocks dust that costs more to index than it is worth.
    uint256 public minDeposit;

    /// @notice Intent identifiers already consumed by a deposit.
    mapping(bytes32 intentId => bool used) public intentUsed;

    event Deposited(address indexed payer, bytes32 indexed intentId, uint256 amount);
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

    /// @notice Deposit the chain's native token against an intent issued by the operator.
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

    /// @notice Withdraw the vault's balance to the operator.
    /// @dev This is the operator's own treasury function and is not a player
    ///      withdrawal path: it can only send to an address the owner names, and
    ///      nothing in this contract lets a player reach it.
    function sweep(address recipient, uint256 amount) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > address(this).balance) revert InsufficientBalance(amount, address(this).balance);

        emit Swept(recipient, amount);

        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Top the vault up without crediting any player.
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
