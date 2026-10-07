import type { Meta, StoryObj } from "@storybook/react";
import { DistributedLockSimulator } from "../components/studio/DistributedLockSimulator";

const meta: Meta<typeof DistributedLockSimulator> = {
  title: "Resilience/DistributedLock",
  component: DistributedLockSimulator,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "Distributed Lock and Heartbeat Watchdog simulator demonstrating lease renewal at TTL/3 and lock safety under process failure.",
      },
    },
  },
  tags: ["autodocs"],
  argTypes: {
    initialTtlMs: {
      control: { type: "number", step: 500, min: 1000, max: 10000 },
    },
  },
};

export default meta;
type Story = StoryObj<typeof DistributedLockSimulator>;

export const Default: Story = {
  args: {
    initialTtlMs: 3000,
  },
};
