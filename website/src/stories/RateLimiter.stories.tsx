import type { Meta, StoryObj } from "@storybook/react";
import { RateLimiterSimulator } from "../components/studio/RateLimiterSimulator";

const meta: Meta<typeof RateLimiterSimulator> = {
  title: "Resilience/RateLimiter",
  component: RateLimiterSimulator,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "Interactive Token Bucket visualizer demonstrating token leakage, replenishment, burst traffic, and RFC 7807 429 Problem Details generation.",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    capacity: { control: { type: "number", min: 2, max: 30 } },
    refillPerSecond: { control: { type: "number", min: 1, max: 10 } },
  },
};

export default meta;
type Story = StoryObj<typeof RateLimiterSimulator>;

export const Default: Story = {
  args: {
    capacity: 10,
    refillPerSecond: 2,
  },
};

export const HighCapacity: Story = {
  args: {
    capacity: 25,
    refillPerSecond: 5,
  },
};
