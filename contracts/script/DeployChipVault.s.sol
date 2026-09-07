// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ChipVault} from "../src/ChipVault.sol";

/// @notice Deploys ChipVault to BNB Smart Chain Testnet.
/// @dev Run with:
///      forge script script/DeployChipVault.s.sol \
///        --rpc-url bsc_testnet --broadcast --verify
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
