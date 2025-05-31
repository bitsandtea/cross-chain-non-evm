// Import the Crypto contract for hashing algorithms.
// Crypto is a built-in contract and can usually be imported by name.
import Crypto
import "FungibleToken"
import "FooToken"
// --- Contract Definition ---
access(all) contract MinimalHTLCv2 {

    access(all) var fungibleTokenVault: @FooToken.Vault
    // --- Data Structures ---
    // Struct to hold all data for a single HTLC.
    // In Cadence, structs are copied when passed around or assigned.



    access(all) struct HTLCData {
        access(all) let id: String
        access(all) let senderAddress: Address
        access(all) let receiverAddress: Address
        access(all) let tokenSymbol: String // e.g., "FOO", "FLOW"; representing the type of token
        access(all) let amount: UFix64
        access(all) let hashlock: [UInt8]   // The SHA3-256 hash of the secret.
        access(all) let timelock: UFix64    // Unix timestamp after which the HTLC can be refunded.
        access(all) var status: String      // "locked", "unlocked", "refunded"
        

        init(
            id: String,
            senderAddress: Address,
            receiverAddress: Address,
            tokenSymbol: String,
            amount: UFix64,
            hashlock: [UInt8],
            timelock: UFix64,
        ) {
            self.id = id
            self.senderAddress = senderAddress
            self.receiverAddress = receiverAddress
            self.tokenSymbol = tokenSymbol
            self.amount = amount
            self.hashlock = hashlock
            self.timelock = timelock
            self.status = "locked" // Initial status when created
            
        }

        access(all) fun setUnlocked() {
            self.status = "unlocked"
        }

        access(all) fun setRefunded() {
            self.status = "refunded"
        }
    }

    // Struct to hold the result of the lock function
    access(all) resource LockResult {
        access(all) let htlcID: String
        access(all) var returnedVault: @{FungibleToken.Vault}

        init(htlcID: String, returnedVault: @{FungibleToken.Vault}) {
            self.htlcID = htlcID
            self.returnedVault <- returnedVault
        }
    }

    // --- Contract State ---
    // Dictionary to store all HTLCs, mapping ID to the HTLCData struct.
    access(self) var htlcs: {String: HTLCData}
    // Counter to generate unique IDs for new HTLCs.
    access(self) var nextHTLCIDCounter: UInt64

    access(all) event HTLCLocked(htlcID: String)

    // --- Public Functions ---

    // Creates a new HTLC and "locks" the conceptual tokens.
    // Since this is minimalistic, no actual tokens are moved or held by the contract.
    access(all) fun lock(
        senderAddress: Address,
        receiverAddress: Address,
        tokenSymbol: String,
        vault: @{FungibleToken.Vault},
        amount: UFix64,
        hashlock: [UInt8], // The pre-computed SHA3-256 hash of the secret.
        timelockTimestamp: UFix64 // Unix timestamp for when refund becomes possible.
    ): @LockResult {
        pre {
            amount > 0.0: "Amount must be positive."
            hashlock.length > 0: "Hashlock (hashed secret) cannot be empty."
            timelockTimestamp > getCurrentBlock().timestamp: "Timelock must be set to a future time."
        }

        // Generate a unique ID for the HTLC.
        let htlcID = "htlc-".concat(self.nextHTLCIDCounter.toString()).concat("-").concat(getCurrentBlock().timestamp.toString())
        self.nextHTLCIDCounter = self.nextHTLCIDCounter + 1


        // Create the new HTLC data struct.
        let newHTLC = HTLCData(
            id: htlcID,
            senderAddress: senderAddress,
            receiverAddress: receiverAddress,
            tokenSymbol: tokenSymbol,
            amount: amount,
            hashlock: hashlock,
            timelock: timelockTimestamp
        )

        // Store the HTLC data in the contract's dictionary.
        self.htlcs[htlcID] = newHTLC

        log("MinimalHTLCv2: Lock created with ID: ".concat(htlcID))
        self.fungibleTokenVault.deposit(from: <- vault.withdraw(amount: amount))

        emit HTLCLocked(htlcID: htlcID)

        return <- create LockResult(htlcID: htlcID, returnedVault: <- vault)
    }

    // "Unlocks" an HTLC if the correct secret is provided and conditions are met.
    access(all) fun unlock(htlcID: String, secret: String, callerAddress: Address): @FooToken.Vault? {
        // Attempt to retrieve and unwrap the HTLC data.
        if var htlc = self.htlcs[htlcID] {
            // HTLC exists, proceed with checks.
            // `htlc` is a mutable copy here.

            // Check if the caller is the designated receiver.
            if callerAddress != htlc.receiverAddress {
                log("MinimalHTLCv2: Unlock attempt by non-receiver. HTLC ID: ".concat(htlcID))
                return nil
            }

            // Check if the HTLC is currently in a "locked" state.
            if htlc.status != "locked" {
                log("MinimalHTLCv2: Unlock attempt on non-locked HTLC. ID: ".concat(htlcID).concat(", Status: ").concat(htlc.status))
                return nil
            }

            // Check if the timelock for refund has expired. If so, unlock is not allowed.
            if getCurrentBlock().timestamp >= htlc.timelock {
                log("MinimalHTLCv2: Unlock attempt after timelock expired. HTLC ID: ".concat(htlcID))
                return nil
            }

            // Verify the provided secret by hashing it and comparing with the stored hashlock.
            let secretBytes = secret.utf8
            let computedHash = Crypto.hash(secretBytes, algorithm: HashAlgorithm.SHA3_256)

            if computedHash != htlc.hashlock {
                log("MinimalHTLCv2: Invalid secret provided for HTLC unlock. ID: ".concat(htlcID))
                return nil
            }

            // If all checks pass, retrieve the amount and withdraw tokens.
            let amountToUnlock = htlc.amount
            let unlockedTokens <- self.fungibleTokenVault.withdraw(amount: amountToUnlock)

            // Update the status of the HTLC copy.
            htlc.setUnlocked()
            // Assign the modified copy back to the dictionary to persist the change.
            self.htlcs[htlcID] = htlc

            log("MinimalHTLCv2: Unlock successful for HTLC ID: ".concat(htlcID).concat(", tokens returned."))
            return <- unlockedTokens

        } else {
            // HTLC not found
            panic("MinimalHTLCv2: Unlock failed. HTLC not found with ID: ".concat(htlcID))
        }
    }

    // "Refunds" an HTLC to the sender if the timelock has expired.
    access(all) fun refund(htlcID: String, callerAddress: Address): Bool {
        // Attempt to retrieve and unwrap the HTLC data.
        if var htlc = self.htlcs[htlcID] {
            // HTLC exists, proceed with checks.
            // `htlc` is a mutable copy here.

            // Check if the caller is the original sender.
            if callerAddress != htlc.senderAddress {
                log("MinimalHTLCv2: Refund attempt by non-sender. HTLC ID: ".concat(htlcID))
                return false
            }

            // Check if the HTLC is currently in a "locked" state.
            if htlc.status != "locked" {
                log("MinimalHTLCv2: Refund attempt on non-locked HTLC. ID: ".concat(htlcID).concat(", Status: ").concat(htlc.status))
                return false
            }

            // Check if the timelock has actually expired.
            if getCurrentBlock().timestamp < htlc.timelock {
                log("MinimalHTLCv2: Refund attempt before timelock expired. HTLC ID: ".concat(htlcID))
                return false
            }

            // Update the status of the HTLC copy.
            htlc.setRefunded()
            // Assign the modified copy back to the dictionary.
            self.htlcs[htlcID] = htlc

            log("MinimalHTLCv2: Refund successful for HTLC ID: ".concat(htlcID))
            return true
        } else {
            // HTLC not found
            panic("MinimalHTLCv2: Refund failed. HTLC not found with ID: ".concat(htlcID))
        }
    }

    // Read-only function to get the details of a specific HTLC.
    // Returns an optional `HTLCData` struct.
    access(all) fun getHTLCDetails(htlcID: String): HTLCData? {
        return self.htlcs[htlcID]
    }

    // --- Contract Initialization ---
    init() {
        self.htlcs = {} // Initialize as an empty dictionary.
        self.nextHTLCIDCounter = 0
        self.fungibleTokenVault <- FooToken.createEmptyVault(vaultType: Type<@FooToken.Vault>())
        log("MinimalHTLCv2 contract initialized successfully.")
    }
} 