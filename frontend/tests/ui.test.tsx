import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import Flash from '../src/components/Flash';
import { Badge, Modal, RiskBar, SeverityBadge, StatusBadge } from '../src/components/ui';

describe('badges and risk bar', () => {
  it('render status, severity and risk information', () => {
    render(<><StatusBadge status="degraded" /><SeverityBadge severity="critical" /><Badge tone="pred">predicted</Badge><RiskBar p={0.874} level="high" /></>);
    expect(screen.getByText('degraded')).toBeInTheDocument();
    expect(screen.getByText('critical')).toHaveClass('crit');
    expect(screen.getByText('predicted')).toHaveClass('pred');
    expect(screen.getByText('87%')).toBeInTheDocument();
  });
});

describe('Modal', () => {
  it('shows its content and closes on Escape or a backdrop click', async () => {
    const onClose = vi.fn();
    render(<Modal title="Edit thing" onClose={onClose}><p>Body text</p></Modal>);
    expect(screen.getByRole('dialog', { name: 'Edit thing' })).toBeInTheDocument();
    expect(screen.getByText('Body text')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('Flash', () => {
  it('highlights briefly when its value changes, not on first render', () => {
    vi.useFakeTimers();
    const { rerender, container } = render(<Flash value={1}>one</Flash>);
    expect(container.firstChild).not.toHaveClass('flash');
    rerender(<Flash value={2}>two</Flash>);
    expect(container.firstChild).toHaveClass('flash');
    act(() => { vi.advanceTimersByTime(1000); });
    expect(container.firstChild).not.toHaveClass('flash');
    vi.useRealTimers();
  });
});
