import { ReactNode, useEffect, useRef, useState } from 'react';

/** Briefly highlights its content whenever `value` changes - makes live updates noticeable without being noisy. */
export default function Flash({ value, children, className = '' }: { value: unknown; children: ReactNode; className?: string }) {
  const prev = useRef(value);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (prev.current === value) return;
    prev.current = value;
    setOn(true);
    const t = setTimeout(() => setOn(false), 900);
    return () => clearTimeout(t);
  }, [value]);
  return <span className={`${className} ${on ? 'flash' : ''}`}>{children}</span>;
}
