import Test
import "FungibleToken"
import "FungibleTokenHTLC"
import "test_helpers.cdc"
import Crypto

access(all) let admin: Test.TestAccount = Test.getAccount(0x0000000000000007)

// Helper function to get the standard FungibleToken address
access(all) fun getFungibleTokenAddress(): Address {
    return 0xee82856bf20e2aa6
}

// Helper function to get the FooToken contract address
// Assumes FooToken is deployed by the `deploy` helper which uses Test.serviceAccount()
access(all) fun getFooTokenAddress(): Address {
    return Test.serviceAccount().address 
}

// Helper function to get the FungibleTokenHTLC contract address
access(all) fun getHTLCAddress(): Address {
    return Test.serviceAccount().address 
}

access(all) var serviceAccount: Test.TestAccount? = nil
access(all) var senderAccount: Test.TestAccount? = nil
access(all) var receiverAccount: Test.TestAccount? = nil

/* Test Setup */
access(all) fun setup() {
    senderAccount = Test.createAccount()
    receiverAccount = Test.createAccount()

    // Deploy contracts using the helper from test_helpers.cdc
    // This deploys them to Test.serviceAccount() and registers them by name.
    deploy("FooToken", "../contracts/FooToken.cdc")
    deploy("FungibleTokenHTLC", "../contracts/FungibleTokenHTLC.cdc")
    
    // Setup sender's FooToken vault using txExecutor
    // This transaction will try to import FooToken from 0xFooToken, 
    // which should resolve to the contract deployed by `deploy("FooToken", ...)`
    let _ = txExecutor(
        "setup_sender_vault.cdc", 
        [senderAccount!], 
        [], 
        nil, 
        nil
    )
}