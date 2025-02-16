import { store } from "@davstack/store";
import { nanoid as id } from "nanoid";
import { minimal, page } from "services/SyncParticipant";

export type Node = { size?: number; key: string; hidden?: boolean };

export type Branch<
  T extends Record<string, unknown> = Record<string, unknown>
> = Node & {
  type: "branch";
  orientation: "vertical" | "horizontal";
  children: Root<T>[];
  locked?: boolean;
};

export type Leaf<T extends Record<string, unknown> = Record<string, unknown>> =
  Node & {
    type: "leaf";
    acceptDrop?: boolean;
    content?: T;
  };

export type Root<T extends Record<string, unknown> = Record<string, unknown>> =
  | Branch<T>
  | Leaf<T>;

export type ViewTreeState = { view: Root<PanelState> };

export type PanelState = {
  type: string;
};

const isSm = () => window.innerWidth < 640;

export const viewStore = store<ViewTreeState>(
  minimal
    ? {
        view: {
          key: id(),
          type: "leaf",
          size: 100,
          acceptDrop: true,
          content: { type: page },
        },
      }
    : getDefaultViewTree()
);

export function getDefaultViewTree(): ViewTreeState {
  return isSm()
    ? {
        view: {
          key: id(),
          type: "branch",
          orientation: "vertical",
          children: [
            {
              key: id(),
              type: "leaf",
              size: 50,
              acceptDrop: true,
              content: { type: "viewport" },
            },
            {
              key: id(),
              type: "leaf",
              size: 50,
              acceptDrop: true,
              content: { type: "steps" },
            },
          ],
        },
      }
    : {
        view: {
          size: 80,
          type: "branch",
          key: id(),
          orientation: "horizontal",
          children: [
            {
              type: "branch",
              key: id(),
              orientation: "vertical",
              size: 25,
              children: [
                {
                  type: "leaf",
                  size: 40,
                  key: id(),
                  acceptDrop: true,
                  content: { type: "layers" },
                },
                {
                  type: "leaf",
                  size: 60,
                  key: id(),
                  acceptDrop: true,
                  content: { type: "steps" },
                },
              ],
            },
            {
              size: 75,
              type: "leaf",
              key: id(),
              acceptDrop: true,
              content: { type: "viewport" },
            },
          ],
        },
      };
}
