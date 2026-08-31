/** Week 3: deterministic transformations before LLM semantic filling. */
export interface CodemodPort {
  transform(files: Map<string, string>): Promise<Map<string, string>>;
}
