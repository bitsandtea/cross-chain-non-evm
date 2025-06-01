"use client";

import { ChangeEvent, FormEvent, useState } from "react";

interface InitiateFlowLockPayload {
  initiatorFlowToken: string;
  initiatorFlowAmount: string;
  initiatorReceivingEvmAddress: string;
  counterpartyEvmLockerAddress: string;
  counterpartyEvmToken: string;
  counterpartyEvmAmount: string;
  counterpartyReceivingFlowAddress: string;
}

interface FullSwapDetails {
  initiatorChain?: string;
  initiatorAddress?: string;
  initiatorToken?: string;
  initiatorAmount?: string;
  initiatorReceivingAddressOnOtherChain?: string;
  counterpartyChain?: string;
  counterpartyAddress?: string;
  counterpartyToken?: string;
  counterpartyAmount?: string;
  counterpartyReceivingAddressOnOtherChain?: string;
  direction?: string;
  hashlock?: string; // Included in fullSwapDetails in API response
}

interface Step1ApiResponse {
  success: boolean;
  log?: string[];
  swapId: string;
  secret: string;
  hashlock: string;
  flowLockTxHash?: string;
  flowHtlcCancellationTimestamp?: string;
  fullSwapDetailsForNextStep?: FullSwapDetails;
  message?: string; // For error cases from API
}

// Structure for composed display after step 1
interface Step1ComposedData {
  swapId: string;
  secret: string;
  hashlock: string;
  flowLockTxHash?: string;
  flowHtlcCancellationTimestamp?: string;
  fullSwapDetailsFromInitiate: FullSwapDetails;
  log?: string[];
}

interface Step2ApiResponse {
  message: string;
  swapId: string;
  evmTransactionHash?: string;
  createdEvmEscrowAddress?: string;
  currentState?: string;
  nextStep?: string; // As per docs
}

interface Step3ApiResponse {
  success: boolean;
  message: string;
  log?: string[];
  evmWithdrawTxHash?: string;
  swapId?: string; // swapId might not be directly in response, but useful for UI state
  error?: string; // For error cases
}

interface Step4ApiResponse {
  success: boolean;
  message: string;
  log?: string[];
  flowWithdrawTxHash?: string;
  swapId?: string; // swapId might not be directly in response, but useful for UI state
  error?: string; // For error cases
}

const initialStep1Payload: InitiateFlowLockPayload = {
  initiatorFlowToken: "A.432050232f9a49e7.FooToken",
  initiatorFlowAmount: "2.0",
  initiatorReceivingEvmAddress: "0xbb2212AA067BA6f33Ff93282F3b2a53E9EA40f1c",
  counterpartyEvmLockerAddress: "0x4AF867B06C96eCf44d23125f958D20d59FBc9921",
  counterpartyEvmToken: "0x331E51974cF08DDB93f488f22B0d6797b2C8b374",
  counterpartyEvmAmount: "2",
  counterpartyReceivingFlowAddress: "0x5e5e07897a1b3daf",
};

export default function SimulationPage() {
  const [currentStage, setCurrentStage] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastApiResponse, setLastApiResponse] = useState<any>(null);

  // Step 1
  const [step1Payload, setStep1Payload] =
    useState<InitiateFlowLockPayload>(initialStep1Payload);
  const [step1ComposedData, setStep1ComposedData] =
    useState<Step1ComposedData | null>(null);

  const handleStep1PayloadChange = (e: ChangeEvent<HTMLInputElement>) => {
    setStep1Payload({ ...step1Payload, [e.target.name]: e.target.value });
  };

  const callApi = async (endpoint: string, method: string, body: any) => {
    setIsLoading(true);
    setError(null);
    setLastApiResponse(null);
    try {
      const response = await fetch(endpoint, {
        method: method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      setLastApiResponse(data);
      if (!response.ok || data.success === false) {
        // Check for data.success for step 1
        throw new Error(
          data.message || data.error || `HTTP error! status: ${response.status}`
        );
      }
      return data;
    } catch (e: any) {
      setError(e.message || "An unknown error occurred");
      setIsLoading(false); // Ensure loading is false on error
      return null;
    } finally {
      // setIsLoading(false); // Moved to success path or error path
    }
  };

  const handleInitiateFlowLock = async (e: FormEvent) => {
    e.preventDefault();
    const data: Step1ApiResponse | null = await callApi(
      "/api/simulation/initiate-flow-lock",
      "POST",
      step1Payload
    );
    if (data && (data.success === true || data.swapId)) {
      let modifiedTimestamp = data.flowHtlcCancellationTimestamp;
      if (data.flowHtlcCancellationTimestamp) {
        try {
          const originalTimestamp = parseInt(
            data.flowHtlcCancellationTimestamp,
            10
          );
          if (!isNaN(originalTimestamp)) {
            const sevenDaysInSeconds = 7 * 24 * 60 * 60;
            modifiedTimestamp = (
              originalTimestamp + sevenDaysInSeconds
            ).toString();
            console.log(
              `Original Timestamp: ${data.flowHtlcCancellationTimestamp}, Modified: ${modifiedTimestamp}`
            ); // For debugging
          } else {
            console.warn("flowHtlcCancellationTimestamp is NaN after parsing");
          }
        } catch (parseError) {
          console.error(
            "Could not parse flowHtlcCancellationTimestamp:",
            parseError
          );
          // Keep original if parsing fails, modifiedTimestamp already holds data.flowHtlcCancellationTimestamp
        }
      }

      setStep1ComposedData({
        swapId: data.swapId,
        secret: data.secret,
        hashlock: data.hashlock,
        flowLockTxHash: data.flowLockTxHash,
        flowHtlcCancellationTimestamp: modifiedTimestamp, // Use the potentially modified timestamp
        fullSwapDetailsFromInitiate: data.fullSwapDetailsForNextStep || {},
        log: data.log,
      });
      setCurrentStage(2);
      setError(null); // Clear previous errors
    }
    setIsLoading(false);
  };

  const handleCompleteEvmSwap = async () => {
    console.log("Attempting to handleCompleteEvmSwap");
    console.log(
      "Payload for Step 2 (Complete EVM Swap) will be step1ComposedData:",
      step1ComposedData
    );

    if (!step1ComposedData || !step1ComposedData.swapId) {
      setError(
        "Data from Step 1 (including Swap ID) not found. Cannot proceed with Step 2."
      );
      return;
    }

    const payload = step1ComposedData;

    const data: Step2ApiResponse | null = await callApi(
      "/api/simulation/complete-evm-swap",
      "POST",
      payload
    );
    if (data && data.swapId) {
      setCurrentStage(3);
      setError(null);
    }
    setIsLoading(false);
  };

  const handleWithdrawFromEvm = async () => {
    if (!step1ComposedData?.swapId || !step1ComposedData?.secret) {
      setError("Swap ID or Secret not found from Step 1.");
      return;
    }
    const payload = {
      swapId: step1ComposedData.swapId,
      secret: step1ComposedData.secret,
    };
    const data: Step3ApiResponse | null = await callApi(
      "/api/swaps/withdraw-evm",
      "POST",
      payload
    );
    if (data && data.success) {
      setCurrentStage(4);
      setError(null);
    }
    setIsLoading(false);
  };

  const handleWithdrawFromFlow = async () => {
    if (!step1ComposedData?.swapId || !step1ComposedData?.secret) {
      setError("Swap ID or Secret not found from Step 1.");
      return;
    }
    const payload = {
      swapId: step1ComposedData.swapId,
      secret: step1ComposedData.secret,
    };
    const data: Step4ApiResponse | null = await callApi(
      "/api/swaps/withdraw-flow",
      "POST",
      payload
    );
    if (data && data.success) {
      // Optionally reset or indicate completion
      // setCurrentStage(5); // Or 1 to restart
      setError(null);
    }
    setIsLoading(false);
  };

  const renderInputField = (
    name: keyof InitiateFlowLockPayload,
    label: string,
    type: string = "text"
  ) => (
    <div className="mb-4">
      <label htmlFor={name} className="block text-sm font-medium text-gray-300">
        {label}:
      </label>
      <input
        type={type}
        id={name}
        name={name}
        value={step1Payload[name]}
        onChange={handleStep1PayloadChange}
        className="mt-1 block w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm text-white"
        disabled={isLoading || currentStage > 1}
      />
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 p-4 sm:p-8">
      <header className="mb-8">
        <h1 className="text-3xl font-bold text-center text-indigo-400">
          Relayer FLOW_TO_EVM Swap Simulation
        </h1>
      </header>

      <div className="space-y-12">
        {/* Step 1: Initiate Flow Lock */}
        <section className="p-6 bg-gray-800 rounded-lg shadow-md">
          <h2 className="text-2xl font-semibold mb-4 text-indigo-300">
            Step 1: Initiate Flow Lock
          </h2>
          <form onSubmit={handleInitiateFlowLock}>
            {renderInputField("initiatorFlowToken", "Initiator Flow Token")}
            {renderInputField("initiatorFlowAmount", "Initiator Flow Amount")}
            {renderInputField(
              "initiatorReceivingEvmAddress",
              "Initiator Receiving EVM Address"
            )}
            {renderInputField(
              "counterpartyEvmLockerAddress",
              "Counterparty EVM Locker Address"
            )}
            {renderInputField(
              "counterpartyEvmToken",
              "Counterparty EVM Token Address"
            )}
            {renderInputField(
              "counterpartyEvmAmount",
              "Counterparty EVM Amount"
            )}
            {renderInputField(
              "counterpartyReceivingFlowAddress",
              "Counterparty Receiving Flow Address"
            )}
            <button
              type="submit"
              disabled={isLoading || currentStage > 1}
              className="w-full mt-4 px-4 py-2 bg-indigo-600 text-white font-semibold rounded-md shadow hover:bg-indigo-700 disabled:bg-gray-500"
            >
              {isLoading && currentStage === 1
                ? "Processing..."
                : "1. Initiate Flow Lock"}
            </button>
          </form>
        </section>

        {step1ComposedData && (
          <section className="p-6 bg-gray-800 rounded-lg shadow-md mt-6">
            <h3 className="text-xl font-semibold mb-2 text-indigo-300">
              Step 1 Results (Context for Next Steps):
            </h3>
            <pre className="bg-gray-700 p-4 rounded-md text-sm overflow-x-auto">
              {JSON.stringify(step1ComposedData, null, 2)}
            </pre>
          </section>
        )}

        {/* Step 2: Complete EVM Swap */}
        {currentStage >= 2 && step1ComposedData && (
          <section className="p-6 bg-gray-800 rounded-lg shadow-md">
            <h2 className="text-2xl font-semibold mb-4 text-indigo-300">
              Step 2: Complete EVM Swap
            </h2>

            <div className="mb-6 p-4 bg-gray-700 rounded-md">
              <h3 className="text-lg font-semibold text-indigo-200 mb-2">
                Context from Step 1 (Payload for this Step):
              </h3>
              <pre className="bg-gray-600 p-3 rounded-md text-xs overflow-x-auto text-gray-200">
                {JSON.stringify(step1ComposedData, null, 2)}
              </pre>
            </div>

            <button
              onClick={handleCompleteEvmSwap}
              disabled={isLoading || currentStage !== 2 || !step1ComposedData}
              className="w-full mt-4 px-4 py-2 bg-indigo-600 text-white font-semibold rounded-md shadow hover:bg-indigo-700 disabled:bg-gray-500"
            >
              {isLoading && currentStage === 2
                ? "Processing..."
                : "2. Complete EVM Swap"}
            </button>
          </section>
        )}

        {/* Step 3: Withdraw from EVM */}
        {currentStage >= 3 && (
          <section className="p-6 bg-gray-800 rounded-lg shadow-md">
            <h2 className="text-2xl font-semibold mb-4 text-indigo-300">
              Step 3: Withdraw from EVM
            </h2>
            <button
              onClick={handleWithdrawFromEvm}
              disabled={
                isLoading || currentStage !== 3 || !step1ComposedData?.secret
              }
              className="w-full mt-4 px-4 py-2 bg-indigo-600 text-white font-semibold rounded-md shadow hover:bg-indigo-700 disabled:bg-gray-500"
            >
              {isLoading && currentStage === 3
                ? "Processing..."
                : "3. Withdraw from EVM"}
            </button>
          </section>
        )}

        {/* Step 4: Withdraw from Flow */}
        {currentStage >= 4 && (
          <section className="p-6 bg-gray-800 rounded-lg shadow-md">
            <h2 className="text-2xl font-semibold mb-4 text-indigo-300">
              Step 4: Withdraw from Flow
            </h2>
            <button
              onClick={handleWithdrawFromFlow}
              disabled={
                isLoading || currentStage !== 4 || !step1ComposedData?.swapId
              }
              className="w-full mt-4 px-4 py-2 bg-indigo-600 text-white font-semibold rounded-md shadow hover:bg-indigo-700 disabled:bg-gray-500"
            >
              {isLoading && currentStage === 4
                ? "Processing..."
                : "4. Withdraw from Flow"}
            </button>
          </section>
        )}

        {/* General loading/error/response display */}
        <div className="mt-8 p-6 bg-gray-800 rounded-lg shadow-md">
          <h3 className="text-xl font-semibold mb-2 text-indigo-300">
            API Interaction Log:
          </h3>
          {isLoading && <p className="text-yellow-400">Loading...</p>}
          {error && (
            <div className="my-4 p-4 bg-red-700 text-white rounded-md">
              Error: {error}
            </div>
          )}
          {lastApiResponse && (
            <div className="mt-4">
              <h4 className="text-lg font-medium text-gray-300">
                Last API Response:
              </h4>
              <pre className="bg-gray-700 p-4 rounded-md text-sm overflow-x-auto">
                {JSON.stringify(lastApiResponse, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>

      <footer className="mt-12 text-center text-sm text-gray-500">
        <p>Relayer Simulation Interface</p>
      </footer>
    </div>
  );
}
