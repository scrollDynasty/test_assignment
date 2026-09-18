import { useEffect, useState } from 'react';
import type { AnswerValue, InteractiveStep, Step } from '@funnel/shared';
import { useI18n } from '../i18n';

/**
 * One component per step *type* (not per screen): texts, options, limits and messages all come from the config.
 * Adding a screen to a config therefore never needs frontend code; a new step type would (and would be
 * rejected by validateConfig until the renderer supports it).
 */

interface StepProps<S extends Step> {
  step: S;
  initial: AnswerValue | undefined;
  onSubmit: (value: AnswerValue | undefined) => void;
  onChange: () => void;
}

export function InfoStep({ step, onSubmit }: StepProps<Extract<Step, { type: 'info' }>>) {
  const { t, tc } = useI18n();
  return (
    <div className="step">
      {step.content.eyebrow && <p className="eyebrow">{tc(step.content.eyebrow)}</p>}
      <h1>{tc(step.content.title)}</h1>
      {step.content.body && <p className="body">{tc(step.content.body)}</p>}
      <div className="actions">
        <button className="primary" autoFocus onClick={() => onSubmit(undefined)}>
          {step.content.primaryActionLabel ? tc(step.content.primaryActionLabel) : t('funnel.continue')}
        </button>
      </div>
    </div>
  );
}

function Header({ step }: { step: InteractiveStep }) {
  const { tc } = useI18n();
  return (
    <>
      <h1 id={`${step.id}-title`}>{tc(step.content.title)}</h1>
      {step.content.helperText && <p className="helper">{tc(step.content.helperText)}</p>}
    </>
  );
}

export function SingleSelectStep({ step, initial, onSubmit, onChange }: StepProps<Extract<Step, { type: 'single-select' }>>) {
  const { t, tc } = useI18n();
  const [value, setValue] = useState<string | undefined>(typeof initial === 'string' ? initial : undefined);
  return (
    <form className="step" noValidate onSubmit={(e) => (e.preventDefault(), onSubmit(value))}>
      <Header step={step} />
      <div className="options" role="radiogroup" aria-labelledby={`${step.id}-title`}>
        {step.input.options.map((o) => (
          <label key={o.value} className={`option ${value === o.value ? 'selected' : ''}`}>
            <input
              type="radio"
              name={step.input.name}
              value={o.value}
              checked={value === o.value}
              onChange={() => (setValue(o.value), onChange())}
            />
            <span>{tc(o.label)}</span>
          </label>
        ))}
      </div>
      <div className="actions">
        <button className="primary" type="submit">{t('funnel.continue')}</button>
      </div>
    </form>
  );
}

export function MultiSelectStep({ step, initial, onSubmit, onChange }: StepProps<Extract<Step, { type: 'multi-select' }>>) {
  const { t, tc } = useI18n();
  const [values, setValues] = useState<string[]>(Array.isArray(initial) ? initial : []);
  const max = step.validation?.maxSelections;
  const toggle = (v: string) => {
    onChange();
    setValues((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]));
  };
  return (
    <form className="step" noValidate onSubmit={(e) => (e.preventDefault(), onSubmit(values))}>
      <Header step={step} />
      <div className="options" role="group" aria-labelledby={`${step.id}-title`}>
        {step.input.options.map((o) => {
          const checked = values.includes(o.value);
          return (
            <label key={o.value} className={`option ${checked ? 'selected' : ''}`}>
              <input type="checkbox" value={o.value} checked={checked} onChange={() => toggle(o.value)} />
              <span>{tc(o.label)}</span>
            </label>
          );
        })}
      </div>
      {max !== undefined && <p className="counter">{t('funnel.selected', { n: values.length, max })}</p>}
      <div className="actions">
        <button className="primary" type="submit">{t('funnel.continue')}</button>
      </div>
    </form>
  );
}

export function NumberStep({ step, initial, onSubmit, onChange }: StepProps<Extract<Step, { type: 'number' }>>) {
  const { t, tc } = useI18n();
  const [text, setText] = useState(typeof initial === 'number' ? String(initial) : '');
  useEffect(() => setText(typeof initial === 'number' ? String(initial) : ''), [step.id, initial]);
  return (
    <form className="step" noValidate onSubmit={(e) => (e.preventDefault(), onSubmit(text))}>
      <Header step={step} />
      <div className="number">
        <input
          aria-labelledby={`${step.id}-title`}
          type="number"
          inputMode="numeric"
          autoFocus
          min={step.input.min}
          max={step.input.max}
          step={step.input.step}
          value={text}
          onChange={(e) => (setText(e.target.value), onChange())}
        />
        {step.input.unit && <span className="unit">{tc(step.input.unit)}</span>}
      </div>
      <div className="actions">
        <button className="primary" type="submit">{t('funnel.continue')}</button>
      </div>
    </form>
  );
}
