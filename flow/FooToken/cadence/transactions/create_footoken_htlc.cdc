import "MinimalHTLCv2"
import Crypto
import "FooToken"
import "FungibleToken"

transaction(
    receiverAddress: Address,
    tokenSymbol: String,
    amount: UFix64,
    secret: String,
    timelockTimestamp: UFix64,
    htlcDeployerAddress: Address,
    // vault: &FooToken.Vault
) {
    let actualSignerAddress: Address

    prepare(signer: auth(Storage) &Account) {
        let vault = signer.storage.borrow<auth(FungibleToken.Withdraw)&FooToken.Vault>(from: FooToken.VaultStoragePath)!
        // if vault == nil {
        //     panic("Could not borrow FooToken.Vault from ".concat(signer.address.toString()))
        // }
        // Borrow a reference to the deployed MinimalHTLCv2 contract
        let MinimalHTLCv2Contract = getAccount(htlcDeployerAddress)
            .contracts.borrow<&MinimalHTLCv2>(name: "MinimalHTLCv2")
            ?? panic("Could not borrow MinimalHTLCv2 contract reference from ".concat(htlcDeployerAddress.toString()))
        let newVault <- FooToken.createEmptyVault(vaultType: Type<@FooToken.Vault>())
        newVault.deposit(from: <- vault.withdraw(amount: amount))

        self.actualSignerAddress = signer.address
        let secretBytes: [UInt8] = secret.utf8
        let hashlock: [UInt8] = Crypto.hash(secretBytes, algorithm: HashAlgorithm.SHA3_256)

        // Call the lock function on the MinimalHTLCv2 contract.
    let htlcID <- MinimalHTLCv2.lock(
            senderAddress: self.actualSignerAddress,
            receiverAddress: receiverAddress,
            tokenSymbol: tokenSymbol,
            vault: <- newVault,
            amount: amount,
            hashlock: hashlock,
            timelockTimestamp: timelockTimestamp
        )

        log("Successfully created MinimalHTLCv2 with ID: ".concat(htlcID.htlcID))

        vault.deposit(from: <- htlcID.returnedVault.withdraw(amount: htlcID.returnedVault.balance))
        destroy htlcID

    }

    // execute {
        
    // }
}
