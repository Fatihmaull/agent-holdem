// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ChipVault} from "../src/ChipVault.sol";

/// @notice Deploys ChipVault to whichever chain the RPC endpoint points at.
/// @dev Nothing here is chain-specific. Prefer `pnpm deploy:vault <chain-key>`,
///      which reads the endpoint from src/lib/chains.ts and writes the deployed
///      address back into .env under that chain's name. By hand:
///      forge script script/DeployChipVault.s.sol \
///        --rpc-url monad_testnet --broadcast
contract DeployChipVault is Script {
    function run() external returns (ChipVault vault) {
        address operator = vm.envAddress("VAULT_OWNER");
        uint256 minDeposit = vm.envOr("VAULT_MIN_DEPOSIT_WEI", uint256(0.01 ether));

        vm.startBroadcast();
        vault = new ChipVault(operator, minDeposit);
        vm.stopBroadcast();

        console.log("ChipVault:", address(vault));
        console.log("owner:", operator);
        console.log("minDeposit (wei):", minDeposit);
    }
}
