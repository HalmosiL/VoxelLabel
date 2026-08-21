import type { Node } from "@xyflow/react";

import { WorkflowCard } from "../../api/workflowApi";

export type CardNodeData = { card: WorkflowCard };
export type CardNode = Node<CardNodeData>;
