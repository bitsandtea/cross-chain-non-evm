// Import the Crypto contract for hashing algorithms.
// Crypto is a built-in contract and can usually be imported by name.
import Crypto

// --- Contract Definition ---
access(all) contract MinimalHTLC {

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
            timelock: UFix64
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

    // --- Contract State ---
    // Dictionary to store all HTLCs, mapping ID to the HTLCData struct.
    access(self) var htlcs: {String: HTLCData}
    // Counter to generate unique IDs for new HTLCs.
    access(self) var nextHTLCIDCounter: UInt64

    // --- Public Functions ---

    // Creates a new HTLC and "locks" the conceptual tokens.
    // Since this is minimalistic, no actual tokens are moved or held by the contract.
    access(all) fun lock(
        senderAddress: Address,
        receiverAddress: Address,
        tokenSymbol: String,
        amount: UFix64,
        hashlock: [UInt8], // The pre-computed SHA3-256 hash of the secret.
        timelockTimestamp: UFix64 // Unix timestamp for when refund becomes possible.
    ): String {
        pre {
            amount > 0.0: "Amount must be positive."
            hashlock.length > 0: "Hashlock (hashed secret) cannot be empty."
            timelockTimestamp > getCurrentBlock().timestamp: "Timelock must be set to a future time."
        }

        // Generate a unique ID for the HTLC.
        let htlcID = "mhtlc-".concat(self.nextHTLCIDCounter.toString())
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

        log("MinimalHTLC: Lock created with ID: ".concat(htlcID))
        return htlcID
    }

    // "Unlocks" an HTLC if the correct secret is provided and conditions are met.
    access(all) fun unlock(htlcID: String, secret: String, callerAddress: Address): Bool {
        // Attempt to retrieve and unwrap the HTLC data.
        if var htlc = self.htlcs[htlcID] {
            // HTLC exists, proceed with checks.
            // `htlc` is a mutable copy here.

            // Check if the caller is the designated receiver.
            if callerAddress != htlc.receiverAddress {
                log("MinimalHTLC: Unlock attempt by non-receiver. HTLC ID: ".concat(htlcID))
                return false
            }

            // Check if the HTLC is currently in a "locked" state.
            if htlc.status != "locked" {
                log("MinimalHTLC: Unlock attempt on non-locked HTLC. ID: ".concat(htlcID).concat(", Status: ").concat(htlc.status))
                return false
            }

            // Check if the timelock for refund has expired. If so, unlock is not allowed.
            if getCurrentBlock().timestamp >= htlc.timelock {
                log("MinimalHTLC: Unlock attempt after timelock expired. HTLC ID: ".concat(htlcID))
                return false
            }

            // Verify the provided secret by hashing it and comparing with the stored hashlock.
            let secretBytes = secret.utf8
            let computedHash = Crypto.hash(secretBytes, algorithm: HashAlgorithm.SHA3_256)

            if computedHash != htlc.hashlock {
                log("MinimalHTLC: Invalid secret provided for HTLC unlock. ID: ".concat(htlcID))
                return false
            }

            // If all checks pass, update the status of the HTLC copy.
            htlc.setUnlocked()
            // Assign the modified copy back to the dictionary to persist the change.
            self.htlcs[htlcID] = htlc

            log("MinimalHTLC: Unlock successful for HTLC ID: ".concat(htlcID))
            return true

        } else {
            // HTLC not found
            panic("MinimalHTLC: Unlock failed. HTLC not found with ID: ".concat(htlcID))
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
                log("MinimalHTLC: Refund attempt by non-sender. HTLC ID: ".concat(htlcID))
                return false
            }

            // Check if the HTLC is currently in a "locked" state.
            if htlc.status != "locked" {
                log("MinimalHTLC: Refund attempt on non-locked HTLC. ID: ".concat(htlcID).concat(", Status: ").concat(htlc.status))
                return false
            }

            // Check if the timelock has actually expired.
            if getCurrentBlock().timestamp < htlc.timelock {
                log("MinimalHTLC: Refund attempt before timelock expired. HTLC ID: ".concat(htlcID))
                return false
            }

            // Update the status of the HTLC copy.
            htlc.setRefunded()
            // Assign the modified copy back to the dictionary.
            self.htlcs[htlcID] = htlc

            log("MinimalHTLC: Refund successful for HTLC ID: ".concat(htlcID))
            return true
        } else {
            // HTLC not found
            panic("MinimalHTLC: Refund failed. HTLC not found with ID: ".concat(htlcID))
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
        log("MinimalHTLC contract initialized successfully.")
    }
} 