import React, { useEffect, useState } from 'react';

/**
 * VoiceBridge — Simple & Clean Loading Modal
 */
export default function LoadingScreen({ onComplete }) {
  const [progress, setProgress] = useState(0);
  const [step, setStep] = useState(0);

  const steps = [
    "Establishing secure link...",
    "Connecting AI VoiceBridge core...",
    "Dispatching emergency services..."
  ];

  useEffect(() => {
    let start = null;
    const duration = 2500; // Faster 2.5s load

    function animate(ts) {
      if (!start) start = ts;
      const elapsed = ts - start;
      const pct = Math.min((elapsed / duration) * 100, 100);
      setProgress(pct);
      
      const stepIndex = Math.min(
        Math.floor((pct / 100) * steps.length),
        steps.length - 1
      );
      setStep(stepIndex);

      if (pct < 100) {
        requestAnimationFrame(animate);
      } else {
        setTimeout(() => onComplete && onComplete(), 400);
      }
    }
    requestAnimationFrame(animate);
  }, [onComplete]);

  return (
    <div className="ls-overlay">
      <div className="ls-modal">
        {/* Central Logo */}
        <div className="ls-core">
          <div className="ls-wave-ring"></div>
          <img src="/favicon.svg" alt="VoiceBridge Core" className="ls-img" />
        </div>

        {/* Branding */}
        <div className="ls-text-group">
          <h1 className="ls-title">VOICEBRIDGE</h1>
          <h2 className="ls-tagline">AI EMERGENCY SYSTEM</h2>
        </div>

        {/* Minimal Progress */}
        <div className="ls-status">
          <div className="ls-typing">
            {steps[step]}<span className="ls-cursor">_</span>
          </div>
          
          <div className="ls-track">
             <div className="ls-fill" style={{ width: `${progress}%` }}></div>
          </div>
        </div>
      </div>
    </div>
  );
}
