import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { InteractiveStep, Step } from '@funnel/shared';
import { MultiSelectStep, NumberStep, SingleSelectStep } from '../src/funnel/steps';
import { I18nProvider } from '../src/i18n';
import { funnelV1 } from './fixtures';

/**
 * Step components render from the real v1 config (one component per step type, no hardcoded screens) and are
 * driven the way a user drives them: by accessible role and label, with the keyboard or the pointer.
 */
const v1 = funnelV1('A');
function step<T extends Step['type']>(id: string, type: T): Extract<Step, { type: T }> {
  const s = v1.steps[id];
  if (!s || s.type !== type) throw new Error(`${id} is not a ${type} step`);
  return s as Extract<Step, { type: T }>;
}

function setup(ui: React.ReactElement) {
  return { user: userEvent.setup(), ...render(<I18nProvider>{ui}</I18nProvider>) };
}
const props = (onSubmit = vi.fn()) => ({ initial: undefined, onSubmit, onChange: vi.fn(), invalid: false });

describe('single-select step', () => {
  const workMode = step('work_mode', 'single-select');
  const title = workMode.content.title as string;

  it('renders the title and every option of the config as a radio in one named group', () => {
    setup(<SingleSelectStep step={workMode} {...props()} />);
    expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    const group = screen.getByRole('radiogroup', { name: title });
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual(workMode.input.options.map((o) => o.value));
    expect(group.contains(radios[0] as Node)).toBe(true);
  });

  it('submits the chosen value; submitting without a choice hands undefined to validation', async () => {
    const onSubmit = vi.fn();
    const { user } = setup(<SingleSelectStep step={workMode} {...props(onSubmit)} />);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onSubmit).toHaveBeenLastCalledWith(undefined);
    await user.click(screen.getByLabelText('Hybrid'));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onSubmit).toHaveBeenLastCalledWith('hybrid');
  });

  it('restores the saved answer (refresh / back) and marks the group invalid for assistive technology', () => {
    render(
      <I18nProvider>
        <SingleSelectStep step={workMode} initial="office" onSubmit={vi.fn()} onChange={vi.fn()} invalid />
      </I18nProvider>,
    );
    expect((screen.getByLabelText('Mostly in the office') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('radiogroup').getAttribute('aria-invalid')).toBe('true');
  });
});

describe('multi-select step', () => {
  const priorities = step('priorities', 'multi-select');

  it('toggles options, counts the selection against the configured maximum and submits them in click order', async () => {
    const onSubmit = vi.fn();
    const { user } = setup(<MultiSelectStep step={priorities} {...props(onSubmit)} />);
    const max = priorities.validation?.maxSelections;
    expect(screen.getByText(`0 / ${max} selected`)).toBeTruthy();
    await user.click(screen.getByLabelText('Deep-focus time'));
    await user.click(screen.getByLabelText('Decision speed'));
    await user.click(screen.getByLabelText('Deep-focus time')); // unticked again
    await user.click(screen.getByLabelText('Lower operating cost'));
    expect(screen.getByText(`2 / ${max} selected`)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onSubmit).toHaveBeenCalledWith(['speed', 'cost']);
  });
});

describe('number step', () => {
  const teamSize: InteractiveStep = step('team_size', 'number');

  it('is a labelled spin button with the configured limits and unit; submits what was typed (validated upstream)', async () => {
    const onSubmit = vi.fn();
    const { user } = setup(<NumberStep step={teamSize as Extract<Step, { type: 'number' }>} {...props(onSubmit)} />);
    const input = screen.getByRole('spinbutton', { name: teamSize.content.title as string });
    expect(input.getAttribute('min')).toBe('1');
    expect(input.getAttribute('max')).toBe('200');
    expect(screen.getByText('people')).toBeTruthy();
    await user.type(input, '12');
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('12');
  });
});
