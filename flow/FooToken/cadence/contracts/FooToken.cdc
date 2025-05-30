import "FungibleToken"
import "MetadataViews"
import "FungibleTokenMetadataViews"

access(all) contract FooToken: FungibleToken {

    access(all) var totalSupply: UFix64

    access(all) let VaultStoragePath: StoragePath
    access(all) let VaultPublicPath: PublicPath
    access(all) let MinterStoragePath: StoragePath

    access(all) event TokensMinted(amount: UFix64, type: String)

    access(all) resource Vault: FungibleToken.Vault {

        access(all) var balance: UFix64

        init(balance: UFix64) {
            self.balance = balance
        }

        /// Called when a fungible token is burned via the `Burner.burn()` method
        access(contract) fun burnCallback() {
            if self.balance > 0.0 {
                FooToken.totalSupply = FooToken.totalSupply - self.balance
            }
            self.balance = 0.0
        }

        access(all) fun deposit(from: @{FungibleToken.Vault}) {
            let vault <- from as! @FooToken.Vault
            self.balance = self.balance + vault.balance
            destroy vault
        }

        access(FungibleToken.Withdraw) fun withdraw(amount: UFix64): @FooToken.Vault {
            self.balance = self.balance - amount
            return <-create Vault(balance: amount)
        }

        /// getSupportedVaultTypes optionally returns a list of vault types that this receiver accepts
        access(all) view fun getSupportedVaultTypes(): {Type: Bool} {
            let supportedTypes: {Type: Bool} = {}
            supportedTypes[self.getType()] = true
            return supportedTypes
        }

        /// Says if the Vault can receive the provided type in the deposit method
        access(all) view fun isSupportedVaultType(type: Type): Bool {
            return self.getSupportedVaultTypes()[type] ?? false
        }

        /// Asks if the amount can be withdrawn from this vault
        access(all) view fun isAvailableToWithdraw(amount: UFix64): Bool {
            return amount <= self.balance
        }

        access(all) view fun getViews(): [Type] {
            return FooToken.getContractViews(resourceType: nil)
        }

        access(all) fun resolveView(_ view: Type): AnyStruct? {
            return FooToken.resolveContractView(resourceType: nil, viewType: view)
        }

        access(all) fun createEmptyVault(): @FooToken.Vault {
            return <-create Vault(balance: 0.0)
        }
    }

    access(all) fun createEmptyVault(vaultType: Type): @FooToken.Vault {
        return <- create Vault(balance: 0.0)
    }

    access(all) view fun getContractViews(resourceType: Type?): [Type] {
        return [
            Type<FungibleTokenMetadataViews.FTView>(),
            Type<FungibleTokenMetadataViews.FTDisplay>(),
            Type<FungibleTokenMetadataViews.FTVaultData>(),
            Type<FungibleTokenMetadataViews.TotalSupply>()
        ]
    }

    access(all) fun resolveContractView(resourceType: Type?, viewType: Type): AnyStruct? {
        switch viewType {
            case Type<FungibleTokenMetadataViews.FTView>():
                return FungibleTokenMetadataViews.FTView(
                    ftDisplay: self.resolveContractView(resourceType: nil, viewType: Type<FungibleTokenMetadataViews.FTDisplay>()) as! FungibleTokenMetadataViews.FTDisplay?,
                    ftVaultData: self.resolveContractView(resourceType: nil, viewType: Type<FungibleTokenMetadataViews.FTVaultData>()) as! FungibleTokenMetadataViews.FTVaultData?
                )
            case Type<FungibleTokenMetadataViews.FTDisplay>():
                let media = MetadataViews.Media(
                        file: MetadataViews.HTTPFile(
                        // Change this to your own SVG image
                        url: "https://assets.website-files.com/5f6294c0c7a8cdd643b1c820/5f6294c0c7a8cda55cb1c936_Flow_Wordmark.svg"
                    ),
                    mediaType: "image/svg+xml"
                )
                let medias = MetadataViews.Medias([media])
                return FungibleTokenMetadataViews.FTDisplay(
                    // Change these to represent your own token
                    name: "Example Foo Token",
                    symbol: "EFT",
                    description: "This fungible token is used as an example to help you develop your next FT #onFlow.",
                    externalURL: MetadataViews.ExternalURL("https://developers.flow.com/build/guides/fungible-token"),
                    logos: medias,
                    socials: {
                        "twitter": MetadataViews.ExternalURL("https://twitter.com/flow_blockchain")
                    }
                )
            case Type<FungibleTokenMetadataViews.FTVaultData>():
                return FungibleTokenMetadataViews.FTVaultData(
                    storagePath: self.VaultStoragePath,
                    receiverPath: self.VaultPublicPath,
                    metadataPath: self.VaultPublicPath,
                    receiverLinkedType: Type<&FooToken.Vault>(),
                    metadataLinkedType: Type<&FooToken.Vault>(),
                    createEmptyVaultFunction: (fun(): @{FungibleToken.Vault} {
                        return <-FooToken.createEmptyVault(vaultType: Type<@FooToken.Vault>())
                    })
                )
            case Type<FungibleTokenMetadataViews.TotalSupply>():
                return FungibleTokenMetadataViews.TotalSupply(
                    totalSupply: FooToken.totalSupply
                )
        }
        return nil
    }

    /// Minter
    ///
    /// Resource object that token admin accounts can hold to mint new tokens.
    ///
    access(all) resource Minter {
        /// mintTokens
        ///
        /// Function that mints new tokens, adds them to the total supply,
        /// and returns them to the calling context.
        ///
        access(all) fun mintTokens(amount: UFix64): @FooToken.Vault {
            FooToken.totalSupply = FooToken.totalSupply + amount
            let vault <-create Vault(balance: amount)
            emit TokensMinted(amount: amount, type: vault.getType().identifier)
            return <-vault
        }
    }

    init() {
        self.totalSupply = 1000.0

        self.VaultStoragePath = /storage/fooTokenVault
        self.VaultPublicPath = /public/fooTokenVault
        self.MinterStoragePath = /storage/fooTokenMinter

        // Create the Vault with the total supply of tokens and save it in storage
        //
        let vault <- create Vault(balance: self.totalSupply)
        emit TokensMinted(amount: vault.balance, type: vault.getType().identifier)
        self.account.storage.save(<-vault, to: self.VaultStoragePath)

        // Create a public capability to the stored Vault that exposes
        // the `deposit` method and getAcceptedTypes method through the `Receiver` interface
        // and the `balance` method through the `Balance` interface
        //
        let fooTokenCap = self.account.capabilities.storage.issue<&FooToken.Vault>(self.VaultStoragePath)
        self.account.capabilities.publish(fooTokenCap, at: self.VaultPublicPath)

        let minter <- create Minter()
        self.account.storage.save(<-minter, to: self.MinterStoragePath)
    }
}