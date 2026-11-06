import React, { useState, useEffect } from 'react';

interface SimulatorCardProps {
  activeOrder?: {
    orderId?: string;
    amount?: number;
    paymentId?: string;
  } | null;
  onPaymentSimulated?: () => void;
}

export function SimulatorCard({ activeOrder, onPaymentSimulated }: SimulatorCardProps) {
  const [senderName, setSenderName] = useState('Rahul Sharma');
  const [amount, setAmount] = useState<string>('');
  const [rrn, setRrn] = useState('629401841605');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string; details?: unknown } | null>(null);

  useEffect(() => {
    if (activeOrder && typeof activeOrder.amount === 'number') {
      setAmount(activeOrder.amount.toFixed(2));
      setRrn(String(Math.floor(100000000000 + Math.random() * 900000000000)));
    }
  }, [activeOrder]);

  const handleSimulate = async () => {
    setLoading(true);
    setResult(null);

    try {
      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        throw new Error('Please specify a valid amount');
      }

      const res = await fetch('/api/simulator/slice-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderName,
          amount: parsedAmount,
          rrn,
          orderId: activeOrder?.orderId || activeOrder?.paymentId,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'Simulation failed');
      }

      const success = Boolean(data.confirmed);
      setResult({
        success,
        message: success
          ? `Slice Bank email verified & Order ${data.matchedOrder?.id || ''} confirmed!`
          : `Processed: ${data.reason || 'Unmatched'}`,
        details: data,
      });

      if (success) {
        onPaymentSimulated?.();
      }
    } catch (err: unknown) {
      setResult({
        success: false,
        message: err instanceof Error ? err.message : 'Unknown simulation error',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-md p-4 bg-neutral-950 border border-neutral-800 rounded-xl text-left space-y-3 font-mono shadow-xl">
      <div className="flex items-center justify-between pb-2 border-b border-neutral-800">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          <span className="text-xs font-bold text-white uppercase tracking-wider">
            Slice Bank Simulator
          </span>
        </div>
        <span className="text-[10px] bg-neutral-800 px-2 py-0.5 rounded text-neutral-400">DEV MODE</span>
      </div>

      <div className="space-y-2">
        <div>
          <label className="text-[10px] text-neutral-400 block mb-0.5">SENDER NAME</label>
          <input
            type="text"
            value={senderName}
            onChange={(e) => setSenderName(e.target.value)}
            className="w-full text-xs px-2.5 py-1.5 bg-neutral-900 border border-neutral-700 rounded text-white focus:outline-none focus:border-white font-sans"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-neutral-400 block mb-0.5">AMOUNT (₹)</label>
            <input
              type="number"
              step="0.01"
              value={amount}
              placeholder={activeOrder?.amount ? activeOrder.amount.toFixed(2) : '1.05'}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full text-xs px-2.5 py-1.5 bg-neutral-900 border border-neutral-700 rounded text-white focus:outline-none focus:border-white font-mono"
            />
          </div>

          <div>
            <label className="text-[10px] text-neutral-400 block mb-0.5">12-DIGIT RRN</label>
            <input
              type="text"
              value={rrn}
              onChange={(e) => setRrn(e.target.value)}
              className="w-full text-xs px-2.5 py-1.5 bg-neutral-900 border border-neutral-700 rounded text-white focus:outline-none focus:border-white font-mono"
            />
          </div>
        </div>

        <button
          onClick={handleSimulate}
          disabled={loading || !amount}
          className="w-full mt-2 py-2 px-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded font-sans text-xs font-semibold flex items-center justify-center gap-2 transition-all cursor-pointer shadow-sm"
        >
          {loading ? (
            <span>Simulating Bank Email...</span>
          ) : (
            <>
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
              <span>Simulate Slice Email (Verify ₹{amount || '0'})</span>
            </>
          )}
        </button>

        {result && (
          <div
            className={`p-2 rounded text-[11px] font-sans flex items-start gap-2 border ${
              result.success
                ? 'bg-emerald-950/60 border-emerald-800 text-emerald-200'
                : 'bg-red-950/60 border-red-800 text-red-200'
            }`}
          >
            <span className="text-xs">{result.success ? '✓' : '⚠'}</span>
            <span className="break-all">{result.message}</span>
          </div>
        )}
      </div>
    </div>
  );
}
