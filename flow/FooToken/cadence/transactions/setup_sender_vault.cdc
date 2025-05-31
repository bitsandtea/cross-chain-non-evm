import "FungibleToken"
import "FooToken"
// This transaction sets up a FooToken vault for the signer
// and publishes the necessary capabilities (Receiver, Balance, Provider).
transaction {
    prepare(signer: auth(Storage, Capabilities) &Account) {
        // Check if a vault already exists
        if signer.storage.borrow<&FooToken.Vault>(from: FooToken.VaultStoragePath) == nil {
            // Create and save a new empty vault
            signer.storage.save(<-FooToken.createEmptyVault(vaultType: Type<@FooToken.Vault>()), to: FooToken.VaultStoragePath)

            let vaultCap = signer.capabilities.storage.issue<&FooToken.Vault>(
            FooToken.VaultStoragePath
        )
        signer.capabilities.publish(vaultCap, at: FooToken.VaultPublicPath)

            // Issue and Publish Receiver capability
            let receiverCap = signer.capabilities.storage.issue<&FooToken.Vault>(/storage/fooTokenVault)
            signer.capabilities.publish(receiverCap, at: /public/fooTokenReceiver)

        }
    }
} 
