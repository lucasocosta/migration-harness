export type TransformationClass =
  | 'STRUCTURE_PRESERVING'
  | 'STRUCTURE_CHANGING'
  | 'BEHAVIORAL_REIMPLEMENTATION';

export type TransformationMechanism = 'CODEMOD' | 'LLM' | 'MANUAL';

export interface TransformationPlanItem {
  sourceSymbol: string;
  targetConcept: string;
  transformationClass: TransformationClass;
  mechanism: TransformationMechanism;
  rationale: string;
}

export interface TransformationPlan {
  unitId: string;
  createdAt: string;
  items: TransformationPlanItem[];
}
