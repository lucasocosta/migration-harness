import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';

export interface AccessibilityReport {
  passed: boolean;
  violations: Array<{ id: string; impact: string | null; helpUrl: string; affectedNodes: number }>;
  incompleteChecks: number;
  manualReviewRequired: true;
}
export async function checkAccessibility(page: Page): Promise<AccessibilityReport> {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  return { passed: result.violations.length === 0, violations: result.violations.map(violation => ({ id: violation.id, impact: violation.impact ?? null, helpUrl: violation.helpUrl, affectedNodes: violation.nodes.length })), incompleteChecks: result.incomplete.length, manualReviewRequired: true };
}
