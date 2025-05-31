// Path: flow/FooToken/cadence/scripts/FungibleTokenHTLC_Simple.cdc
// This script retrieves and prints the details of a specific HTLC
// managed by the MinimalHTLCv2 contract.

import "MinimalHTLCv2"

// Parameters for the main function:
// - htlcID: The ID of the HTLC whose details are to be retrieved.
// - contractDeployerAddress: The Flow address where the MinimalHTLCv2 contract is deployed.
//                            The contract must be deployed under the name "MinimalHTLCv2".

access(all) fun main(htlcID: String, contractDeployerAddress: Address): MinimalHTLCv2.HTLCData? {
    // Attempt to borrow a reference to the MinimalHTLCv2 contract
    // from the specified deployer address.
    let htlcContract = getAccount(contractDeployerAddress)
        .contracts.borrow<&MinimalHTLCv2>(name: "MinimalHTLCv2")
        ?? panic("Could not borrow MinimalHTLCv2 contract reference from account ".concat(contractDeployerAddress.toString()).concat(". Ensure the contract is deployed there under the name \"MinimalHTLCv2\"."))

    log("Successfully borrowed MinimalHTLCv2 contract from address: ".concat(contractDeployerAddress.toString()))

    // Call the public function to get details for the specified HTLC ID.
    let htlcDetails = htlcContract.getHTLCDetails(htlcID: htlcID)

    if htlcDetails == nil {
        log("No HTLC found with ID: ".concat(htlcID))
    } else {
        log("--- HTLC Details for ID: ".concat(htlcID).concat(" ---"))
        log("  HTLC ID (from struct): ".concat(htlcDetails!.id))
        log("  Sender Address: ".concat(htlcDetails!.senderAddress.toString()))
        log("  Receiver Address: ".concat(htlcDetails!.receiverAddress.toString()))
        log("  Token Symbol: ".concat(htlcDetails!.tokenSymbol))
        log("  Amount: ".concat(htlcDetails!.amount.toString()))
        log("  Timelock (Unix Timestamp): ".concat(htlcDetails!.timelock.toString()))
        log("  Status: ".concat(htlcDetails!.status))
        // Note: The hashlock ([UInt8]) is not logged here for brevity, as its raw byte array representation
        // is typically not directly human-readable for quick state inspection.
        log("-----------------------------")
    }

    // Important Note on Contract State Access:
    // This script can only retrieve details for individual HTLCs via the public `getHTLCDetails` function.
    // The full list of all HTLCs (the `htlcs` dictionary) and the `nextHTLCIDCounter` are private
    // (`access(self)`) within the MinimalHTLCv2 contract.
    // To get the complete state (e.g., all HTLCs, total count), the MinimalHTLCv2 contract
    // itself would need to be modified to include a public function that exposes this information.

    return htlcDetails
} 