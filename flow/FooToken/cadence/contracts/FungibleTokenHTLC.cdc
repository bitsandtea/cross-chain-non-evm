import "FungibleToken"

// Import the Crypto contract for hashing algorithms.
// Crypto is a built-in contract and can usually be imported by name.
import Crypto

// --- Contract Definition ---
access(all) contract FungibleTokenHTLC {
    // --- Events ---
    // Emitted when a new HTLC is created and tokens are locked.
    access(all) event HTLCCreated(
        id: String,
        senderAddress: Address,
        receiverAddress: Address,
        tokenContractAddress: Address,
        tokenContractName: String,
        amount: UFix64,
        hashlock: [UInt8],
        timelock: UFix64 // Unix timestamp
    )

    // Emitted when the receiver successfully withdraws the tokens.
    access(all) event HTLCWithdrawn(
        id: String,
        receiverAddress: Address,
        secret: String // The revealed secret
    )

    // Emitted when the sender successfully reclaims (refunds) the tokens after expiration.
    access(all) event HTLCRefunded(
        id: String,
        senderAddress: Address
    )

    // --- Paths ---
    // Storage path for the HTLCManager resource in the contract deployer's account.
    access(all) let HTLCManagerStoragePath: StoragePath
    // Public path for others to access the HTLCManager's public capabilities.
    access(all) let HTLCManagerPublicPath: PublicPath

    // --- HTLC Status Enum ---
    // Represents the possible states of an HTLC.
    access(all) enum HTLCStatus: UInt8 {
        access(all) case Active      // Tokens are locked, HTLC can be withdrawn or refunded (if expired).
        access(all) case Withdrawn   // Tokens have been successfully withdrawn by the receiver.
        access(all) case Refunded    // Tokens have been successfully refunded to the sender.
    }

    // --- HTLC Resource ---
    // Represents a single Hashed TimeLock Contract instance, holding locked tokens and its state.
    access(all) resource HTLCResource {
        access(all) let id: String
        access(all) let senderAddress: Address
        access(all) let receiverAddress: Address
        access(all) let tokenContractAddress: Address // Address of the specific fungible token contract
        access(all) let tokenContractName: String   // Name of the specific fungible token (e.g., "FlowToken", "FUSD")
        access(all) let amount: UFix64
        access(all) let hashlock: [UInt8] // The SHA3-256 hash of the secret.
        access(all) let timelock: UFix64  // Unix timestamp after which the HTLC can be refunded.
        access(all) var status: HTLCStatus

        // The vault holding the locked fungible tokens.
        // This vault is specific to the type of token locked in this HTLC.
        access(self) let lockedVault: @{FungibleToken.Vault}

        init(
            id: String,
            senderAddress: Address,
            receiverAddress: Address,
            tokenContractAddress: Address,
            tokenContractName: String,
            amount: UFix64,
            hashlock: [UInt8],
            timelock: UFix64,
            initialTokens: @{FungibleToken.Vault}
        ) {
            pre {
                initialTokens.balance == amount: "Initial token vault balance must match the HTLC amount."
                timelock > getCurrentBlock().timestamp: "Timelock must be in the future."
                hashlock.length > 0: "Hashlock cannot be empty." // Basic validation
            }

            self.id = id
            self.senderAddress = senderAddress
            self.receiverAddress = receiverAddress
            self.tokenContractAddress = tokenContractAddress
            self.tokenContractName = tokenContractName
            self.amount = amount
            self.hashlock = hashlock
            self.timelock = timelock
            self.status = HTLCStatus.Active
            self.lockedVault <- initialTokens

            log("HTLCResource initialized: ".concat(self.id))
        }

        // Internal function for withdrawal logic.
        // Verifies conditions and changes status. Returns the vault.
        access(contract) fun withdrawInternal(secret: String, callerAddress: Address): @{FungibleToken.Vault} {
            pre {
                self.status == HTLCStatus.Active: "HTLC is not active."
                callerAddress == self.receiverAddress: "Caller is not the designated receiver."
                getCurrentBlock().timestamp < self.timelock: "Timelock has expired; withdrawal not allowed."
            }

            // Verify the secret by hashing it and comparing with the stored hashlock.
            let secretBytes = secret.utf8
            let computedHash = Crypto.hash(secretBytes, algorithm: HashAlgorithm.SHA3_256)

            if computedHash != self.hashlock {
                panic("Invalid secret provided for HTLC withdrawal.")
            }

            // Use a provider reference to withdraw the full vault balance safely
            let providerRef = &self.lockedVault as auth(FungibleToken.Withdraw) &{FungibleToken.Provider}
            let amountToSend: UFix64 = self.lockedVault.balance
            let withdrawn <- providerRef.withdraw(amount: amountToSend)

            self.status = HTLCStatus.Withdrawn
            log("HTLC status changed to Withdrawn for ID: ".concat(self.id))
            return <- withdrawn
        }

        // Internal function for refund logic.
        // Verifies conditions and changes status. Returns the vault.
        access(contract) fun refundInternal(callerAddress: Address): @{FungibleToken.Vault} {
            pre {
                self.status == HTLCStatus.Active: "HTLC is not active."
                callerAddress == self.senderAddress: "Caller is not the original sender."
                getCurrentBlock().timestamp >= self.timelock: "Timelock has not yet expired; refund not allowed."
            }

            let providerRef = &self.lockedVault as auth(FungibleToken.Withdraw) &{FungibleToken.Provider}
            let amountToSend: UFix64 = self.lockedVault.balance
            let refunded <- providerRef.withdraw(amount: amountToSend)

            self.status = HTLCStatus.Refunded
            log("HTLC status changed to Refunded for ID: ".concat(self.id))
            return <- refunded
        }

        // Read-only details for inspection
        access(all) fun getDetails(): {String: AnyStruct} {
            return {
                "id": self.id,
                "senderAddress": self.senderAddress,
                "receiverAddress": self.receiverAddress,
                "tokenContractAddress": self.tokenContractAddress,
                "tokenContractName": self.tokenContractName,
                "amount": self.amount,
                "hashlock": self.hashlock, // Consider if hashlock should be public
                "timelock": self.timelock,
                "status": self.status.rawValue, // Return rawValue for easier off-chain consumption
                "balance": self.lockedVault.balance // Current balance of the internal vault
            }
        }
    }

    // --- HTLCManager Public Interface ---
    // Defines the public functions that can be called on the HTLCManager.
    access(all) resource interface HTLCManagerPublic {
        access(all) fun newHTLC(
            senderAddress: Address,
            senderTokenProvider: Capability<auth(FungibleToken.Withdraw) &{FungibleToken.Provider}>,
            receiverAddress: Address,
            tokenContractAddress: Address,
            tokenContractName: String,
            amount: UFix64,
            hashlock: [UInt8],
            timelockTimestamp: UFix64
        ): String // Returns the new HTLC ID

        access(all) fun withdraw(
            htlcID: String,
            secret: String,
            receiverTokenReceiver: Capability<&{FungibleToken.Receiver}>
        )

        access(all) fun refund(
            htlcID: String,
            senderTokenReceiver: Capability<&{FungibleToken.Receiver}>
        )

        access(all) fun getHTLCDetails(htlcID: String): {String: AnyStruct}?
    }

    // --- HTLCManager Resource ---
    // Manages all HTLCs within this contract. An instance of this resource
    // will be stored in the contract deployer's account.
    access(all) resource HTLCManager: HTLCManagerPublic {
        // Dictionary to store active HTLC resources, mapping ID to the resource.
        access(self) var htlcs: @{String: HTLCResource}
        // Counter to generate unique IDs for new HTLCs.
        access(self) var nextHTLCIDCounter: UInt64

        init() {
            self.htlcs <- {}
            self.nextHTLCIDCounter = 0
            log("HTLCManager initialized.")
        }

        // Creates a new HTLC.
        access(all) fun newHTLC(
            senderAddress: Address,
            senderTokenProvider: Capability<auth(FungibleToken.Withdraw) &{FungibleToken.Provider}>,
            receiverAddress: Address,
            tokenContractAddress: Address,
            tokenContractName: String,
            amount: UFix64,
            hashlock: [UInt8],
            timelockTimestamp: UFix64
        ): String {
            pre {
                amount > 0.0: "HTLC amount must be positive."
                senderTokenProvider.borrow() != nil: "Sender token provider capability is invalid."
            }

            // Borrow the sender's vault provider capability to withdraw tokens.
            let provider = senderTokenProvider.borrow()
                ?? panic("Failed to borrow sender's FungibleToken.Provider capability.")

            // Withdraw the specified amount from the sender's vault.
            let lockedTokens <- provider.withdraw(amount: amount)
            log("Tokens withdrawn from sender for new HTLC: ".concat(amount.toString()))

            // Generate a unique ID for the HTLC.
            let htlcIDAsString = "htlc-".concat(self.nextHTLCIDCounter.toString())
            self.nextHTLCIDCounter = self.nextHTLCIDCounter + 1

            // Create the new HTLC resource.
            let newHTLC <- create HTLCResource(
                id: htlcIDAsString,
                senderAddress: senderAddress,
                receiverAddress: receiverAddress,
                tokenContractAddress: tokenContractAddress,
                tokenContractName: tokenContractName,
                amount: amount,
                hashlock: hashlock,
                timelock: timelockTimestamp,
                initialTokens: <- lockedTokens
            )
            log("New HTLCResource created with ID: ".concat(htlcIDAsString))

            // Store the new HTLC resource in the manager's dictionary.
            let oldHTLC <- self.htlcs[htlcIDAsString] <- newHTLC
            // The `destroy` keyword is used here to deallocate the memory for `oldHTLC` if it exists.
            // If `htlcIDAsString` is truly unique, `oldHTLC` will be `nil` and `destroy` does nothing.
            destroy oldHTLC

            // Emit an event for HTLC creation.
            emit HTLCCreated(
                id: htlcIDAsString,
                senderAddress: senderAddress,
                receiverAddress: receiverAddress,
                tokenContractAddress: tokenContractAddress,
                tokenContractName: tokenContractName,
                amount: amount,
                hashlock: hashlock,
                timelock: timelockTimestamp
            )
            log("HTLCCreated event emitted for ID: ".concat(htlcIDAsString))

            return htlcIDAsString
        }

        // Allows the receiver to withdraw tokens from an HTLC.
        access(all) fun withdraw(
            htlcID: String,
            secret: String,
            receiverTokenReceiver: Capability<&{FungibleToken.Receiver}>
        ) {
            pre {
                receiverTokenReceiver.borrow() != nil: "Receiver token receiver capability is invalid."
            }

            // Retrieve and remove the HTLC resource from storage.
            // This ensures it can't be processed again.
            let htlc <- self.htlcs.remove(key: htlcID)
                ?? panic("HTLC not found with ID: ".concat(htlcID).concat(" or already processed."))
            log("HTLCResource retrieved for withdrawal, ID: ".concat(htlcID))

            // Perform withdrawal logic using the HTLCResource's internal method.
            let tokensToWithdraw <- htlc.withdrawInternal(secret: secret, callerAddress: htlc.receiverAddress)

            // Borrow the receiver's vault capability to deposit tokens.
            let receiver = receiverTokenReceiver.borrow()
                ?? panic("Failed to borrow receiver's FungibleToken.Receiver capability.")

            // Deposit the tokens into the receiver's vault.
            receiver.deposit(from: <- tokensToWithdraw)
            log("Tokens deposited to receiver for HTLC ID: ".concat(htlcID))

            // Emit an event for HTLC withdrawal.
            emit HTLCWithdrawn(
                id: htlcID,
                receiverAddress: htlc.receiverAddress,
                secret: secret // Revealing the secret on-chain
            )
            log("HTLCWithdrawn event emitted for ID: ".concat(htlcID))

            // Destroy the HTLC resource now that it's processed.
            destroy htlc
        }

        // Allows the sender to refund tokens from an HTLC after the timelock has expired.
        access(all) fun refund(
            htlcID: String,
            senderTokenReceiver: Capability<&{FungibleToken.Receiver}>
        ) {
            pre {
                senderTokenReceiver.borrow() != nil: "Sender token receiver capability is invalid."
            }

            // Retrieve and remove the HTLC resource.
            let htlc <- self.htlcs.remove(key: htlcID)
                ?? panic("HTLC not found with ID: ".concat(htlcID).concat(" or already processed."))
            log("HTLCResource retrieved for refund, ID: ".concat(htlcID))

            // Perform refund logic using the HTLCResource's internal method.
            let tokensToRefund <- htlc.refundInternal(callerAddress: htlc.senderAddress)

            // Borrow the sender's vault capability to deposit tokens.
            let sender = senderTokenReceiver.borrow()
                ?? panic("Failed to borrow sender's FungibleToken.Receiver capability.")

            // Deposit the tokens back into the sender's vault.
            sender.deposit(from: <- tokensToRefund)
            log("Tokens refunded to sender for HTLC ID: ".concat(htlcID))

            // Emit an event for HTLC refund.
            emit HTLCRefunded(
                id: htlcID,
                senderAddress: htlc.senderAddress
            )
            log("HTLCRefunded event emitted for ID: ".concat(htlcID))

            // Destroy the HTLC resource.
            destroy htlc
        }

        // Returns the details of a specific HTLC.
        // This is a read-only function and does not modify state.
        access(all) fun getHTLCDetails(htlcID: String): {String: AnyStruct}? {
            // Get a reference to the dictionary field itself.
            let htlcsRef: &{String: FungibleTokenHTLC.HTLCResource} = &self.htlcs
            // Accessing the dictionary reference by key yields an optional reference to the resource.
            if let htlcRefOptional = htlcsRef[htlcID] { // htlcRefOptional is &HTLCResource?
                return htlcRefOptional.getDetails()      // Call getDetails on &HTLCResource
            }
            return nil
        }
    }

    // --- Contract Initialization ---
    init() {
        // Define standard paths.
        // Users will use these paths to interact with the HTLCManager.
        self.HTLCManagerStoragePath = /storage/flowHTLCManager_v1
        self.HTLCManagerPublicPath = /public/flowHTLCManager_v1 // Ensure this is unique

        // Create an instance of the HTLCManager and save it to the contract deployer's account storage.
        let manager <- create HTLCManager()
        self.account.storage.save(<-manager, to: self.HTLCManagerStoragePath)
        log("HTLCManager resource saved to contract account storage.")

        // Create a public capability for the HTLCManager, allowing others to interact with it.
        // This links the public path to the stored resource, restricted by the HTLCManagerPublic interface.
        // Unpublish any existing capability at the public path first as a best practice.
        self.account.capabilities.unpublish(self.HTLCManagerPublicPath)
        // Issue a capability from storage and publish it to the public path.
        self.account.capabilities.publish(
            self.account.capabilities.storage.issue<&{FungibleTokenHTLC.HTLCManagerPublic}>(self.HTLCManagerStoragePath),
            at: self.HTLCManagerPublicPath
        )
        log("Public capability for HTLCManager created and linked.")

        log("FungibleTokenHTLC contract initialized successfully.")
    }
} 