import "MinimalHTLCv2"
import "FooToken"
import "FungibleToken"

// This transaction attempts to unlock an HTLC using a secret and deposit
// the released FooTokens into the signer's vault.
// The signer of this transaction is assumed to be the designated receiver of the HTLC.
transaction(
    htlcID: String,
    secret: String,
    htlcDeployerAddress: Address // Address where the MinimalHTLCv2 contract is deployed
) {
    // Reference to the signer's FooToken vault, optional
    var receiverRef: &FooToken.Vault?

    // This will hold the vault resource returned by the unlock function, if successful.
    var tempVault: @FooToken.Vault?

    prepare(signer: auth(Storage) &Account) {
        // Initialize fields
        self.receiverRef = nil

        // Borrow a reference to the deployed MinimalHTLCv2 contract
        let htlcContract = getAccount(htlcDeployerAddress)
            .contracts.borrow<&MinimalHTLCv2>(name: "MinimalHTLCv2")
            ?? panic("Could not borrow MinimalHTLCv2 contract reference from ".concat(htlcDeployerAddress.toString()).concat(". Ensure it's deployed under the name 'MinimalHTLCv2'."))

        log("Attempting to unlock HTLC with ID: ".concat(htlcID))

        // Call the unlock function on the MinimalHTLCv2 contract.
        self.tempVault <- htlcContract.unlock(
            htlcID: htlcID,
            secret: secret,
            callerAddress: signer.address
        )

        if self.tempVault == nil {
            log("HTLC unlock failed for ID: ".concat(htlcID))
        } else {
            log("HTLC unlocked successfully. A FooToken.Vault was returned for HTLC ID: ".concat(htlcID))
            // Attempt to borrow a reference to the signer's FooToken vault.
            self.receiverRef = signer.storage.borrow<&FooToken.Vault>(from: FooToken.VaultStoragePath)
            
            if self.receiverRef == nil {
                log("Could not borrow FooToken.Vault reference from signer's storage. Tokens from HTLC ID: ".concat(htlcID).concat(" may be destroyed if unclaimed."))
            } else {
                log("Successfully borrowed reference to signer's FooToken vault for HTLC ID: ".concat(htlcID))
            }
        }
    }

    execute {
        if self.receiverRef != nil {
            // Receiver vault is available
            if let vaultToDeposit <- self.tempVault {
                // tempVault contained a resource, move it
                let balance = vaultToDeposit.balance
                self.receiverRef!.deposit(from: <- vaultToDeposit)
                log("Successfully deposited ".concat(balance.toString()).concat(" FooToken into the signer's vault from HTLC ID: ".concat(htlcID)))
                // self.tempVault is now nil and vaultToDeposit is consumed.
            } else {
                // tempVault was already nil (unlock failed or no tokens)
                log("HTLC unlock failed or no tokens to process for HTLC ID: ".concat(htlcID).concat(" (receiver vault was available)"))
            }
        } else {
            // Receiver vault is NOT available
            if let vaultToDestroy <- self.tempVault {
                // tempVault contained a resource, move it and destroy
                log("Receiver vault not available for HTLC ID: ".concat(htlcID).concat(". Destroying unclaimed tokens."))
                destroy vaultToDestroy
                // self.tempVault is now nil and vaultToDestroy is destroyed.
            } else {
                // tempVault was already nil
                log("HTLC unlock failed or no tokens to process for HTLC ID: ".concat(htlcID).concat(" (receiver vault not available)"))
            }
        }
        // After these conditional blocks, any resource that was in self.tempVault
        // has been moved out and either deposited or destroyed.
        // self.tempVault itself is nil if it ever contained a resource that was moved.
    }
} 