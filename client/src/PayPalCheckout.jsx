import { useEffect, useRef, useState } from 'react';

// Kept outside the component so PayPal's script is only ever added to the page once.
let sdkPromise = null;

function loadPayPalSdk(clientId) {
  sdkPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture`;
    script.onload = () => resolve(window.paypal);
    script.onerror = () => {
      sdkPromise = null;
      reject(new Error('Could not load the PayPal script'));
    };
    document.head.append(script);
  });
  return sdkPromise;
}

async function requestJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed with status ${res.status}`);
  return data;
}

// PayPal's own button for one order the server already created (the approved reorders).
// The owner signs in at PayPal and approves; the server then captures the payment.
export default function PayPalCheckout({ orderId, onPaid, onError }) {
  const containerRef = useRef(null);
  const [message, setMessage] = useState('Loading PayPal…');

  useEffect(() => {
    let cancelled = false;
    let buttons = null;

    async function render() {
      const { paypalClientId } = await requestJson('/api/config');
      const paypal = await loadPayPalSdk(paypalClientId);
      if (cancelled) return;
      setMessage('');
      buttons = paypal.Buttons({
        style: { layout: 'horizontal', tagline: false, height: 40 },
        createOrder: () => orderId,
        onApprove: async () => {
          setMessage('Confirming the payment with PayPal…');
          try {
            onPaid(await requestJson(`/api/orders/${encodeURIComponent(orderId)}/capture`, { method: 'POST' }));
            setMessage('');
          } catch (err) {
            setMessage(`Payment not completed: ${err.message}`);
            onError?.(err);
          }
        },
        onCancel: () => setMessage('Payment cancelled. Nothing was charged; you can try again.'),
        onError: (err) => {
          setMessage(`PayPal error: ${err.message}`);
          onError?.(err);
        },
      });
      await buttons.render(containerRef.current);
    }

    render().catch((err) => {
      if (!cancelled) setMessage(`PayPal failed to load: ${err.message}`);
    });

    // React can remove this component at any time, so the button cleans up after itself.
    return () => {
      cancelled = true;
      buttons?.close();
    };
  }, [orderId, onPaid, onError]);

  return (
    <div>
      <div ref={containerRef} />
      {message && <p className="muted">{message}</p>}
    </div>
  );
}
