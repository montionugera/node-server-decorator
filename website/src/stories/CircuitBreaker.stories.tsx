import type { Meta, StoryObj } from "@storybook/react";
import { CircuitBreakerSimulator } from "../components/studio/CircuitBreakerSimulator";

const meta: Meta<typeof CircuitBreakerSimulator> = {
  title: "Resilience/CircuitBreaker",
  component: CircuitBreakerSimulator,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "Interactive visual state machine for the `@circuitBreaker` decorator. Demonstrates CLOSED, OPEN, and HALF-OPEN transitions with configurable thresholds.",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    failureThreshold: { control: { type: "number", min: 1, max: 10 } },
    resetTimeoutMs: {
      control: { type: "number", step: 500, min: 1000, max: 10000 },
    },
    trialSuccesses: { control: { type: "number", min: 1, max: 5 } },
  },
};

export default meta;
type Story = StoryObj<typeof CircuitBreakerSimulator>;

export const Default: Story = {
  args: {
    failureThreshold: 3,
    resetTimeoutMs: 3000,
    trialSuccesses: 2,
  },
};

export const SensitiveCircuit: Story = {
  args: {
    failureThreshold: 2,
    resetTimeoutMs: 5000,
    trialSuccesses: 3,
  },
};
