import type { Meta, StoryObj } from "@storybook/react";
import { EntitySpecStudio } from "../components/studio/EntitySpecStudio";

const meta: Meta<typeof EntitySpecStudio> = {
  title: "EntitySpec/Studio",
  component: EntitySpecStudio,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Interactive visual entity schema designer and multi-language compiler. Generates Canonical EntitySpec IR, OpenAPI 3.1 JSON, DTO validators, and REST router mounting code in real-time.",
      },
    },
  },
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof EntitySpecStudio>;

export const Default: Story = {};
