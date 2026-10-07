import type { Meta, StoryObj } from "@storybook/react";
import { CoalesceLoaderSimulator } from "../components/studio/CoalesceLoaderSimulator";

const meta: Meta<typeof CoalesceLoaderSimulator> = {
  title: "Resilience/CoalesceLoader",
  component: CoalesceLoaderSimulator,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "Interactive DataLoader & Reactive Call Coalescing simulator demonstrating event-loop microtask tick batching and singleflight database query reduction.",
      },
    },
  },
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof CoalesceLoaderSimulator>;

export const Default: Story = {};
