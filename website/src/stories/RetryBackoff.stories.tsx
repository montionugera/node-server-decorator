import type { Meta, StoryObj } from "@storybook/react";
import { RetryBackoffSimulator } from "../components/studio/RetryBackoffSimulator";

const meta: Meta<typeof RetryBackoffSimulator> = {
  title: "Resilience/RetryBackoff",
  component: RetryBackoffSimulator,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "Visual attempt timeline and jitter analysis for the `@retry` decorator.",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    maxAttempts: { control: { type: "number", min: 1, max: 10 } },
    backoffMs: { control: { type: "number", min: 50, max: 1000 } },
    maxBackoffMs: { control: { type: "number", min: 500, max: 5000 } },
  },
};

export default meta;
type Story = StoryObj<typeof RetryBackoffSimulator>;

export const Default: Story = {
  args: {
    maxAttempts: 3,
    backoffMs: 200,
    maxBackoffMs: 2000,
  },
};

export const AggressiveRetry: Story = {
  args: {
    maxAttempts: 5,
    backoffMs: 100,
    maxBackoffMs: 1500,
  },
};
