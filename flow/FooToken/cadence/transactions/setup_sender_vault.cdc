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

    
    
        }

        let providerReceiverCap = signer.capabilities.storage.issue<&{FungibleToken.Provider, FungibleToken.Receiver}>(FooToken.VaultStoragePath)
        // signer.capabilities.unpublish(FooToken.VaultPublicPath)
        signer.capabilities.publish(providerReceiverCap, at: FooToken.VaultPublicPath)
    }
}
