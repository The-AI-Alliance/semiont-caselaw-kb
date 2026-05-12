/**
 * Tag schemas owned by semiont-caselaw-kb.
 *
 * Schemas are runtime-registered per KB via `frame.addTagSchema(...)`.
 * Skills that use a schema register it at startup (idempotent — re-running
 * a script with identical content is silent at the projection layer).
 *
 * The `register-tag-schemas` skill registers all three at once for KB
 * bootstrap. The `tag-irac` and `subsequent-treatment` skills additionally
 * self-register the schemas they use.
 */

import type { TagSchema } from '@semiont/sdk';

export const LEGAL_IRAC_SCHEMA: TagSchema = {
  id: 'legal-irac',
  name: 'Legal Analysis (IRAC)',
  description: 'Issue, Rule, Application, Conclusion framework for legal reasoning',
  domain: 'legal',
  tags: [
    {
      name: 'Issue',
      description: 'The legal question or problem to be resolved',
      examples: [
        'What is the central legal question?',
        'What must the court decide?',
        'What is the dispute about?',
      ],
    },
    {
      name: 'Rule',
      description: 'The relevant law, statute, or legal principle',
      examples: [
        'What law applies?',
        'What is the legal standard?',
        'What statute governs this case?',
      ],
    },
    {
      name: 'Application',
      description: 'How the rule applies to the specific facts',
      examples: [
        'How does the law apply to these facts?',
        'Analysis of the case',
        'How do the facts satisfy the legal standard?',
      ],
    },
    {
      name: 'Conclusion',
      description: 'The resolution or outcome based on the analysis',
      examples: [
        "What is the court's decision?",
        'What is the final judgment?',
        'What is the holding?',
      ],
    },
  ],
};

export const ARGUMENT_TOULMIN_SCHEMA: TagSchema = {
  id: 'argument-toulmin',
  name: 'Argument Structure (Toulmin)',
  description: 'Claim, Evidence, Warrant, Counterargument, Rebuttal framework for argumentation',
  domain: 'general',
  tags: [
    {
      name: 'Claim',
      description: 'The main assertion or thesis',
      examples: [
        'What is being argued?',
        'What is the main point?',
        'What position is being taken?',
      ],
    },
    {
      name: 'Evidence',
      description: 'Data or facts supporting the claim',
      examples: [
        'What supports this claim?',
        'What are the facts?',
        'What data is provided?',
      ],
    },
    {
      name: 'Warrant',
      description: 'Reasoning connecting evidence to claim',
      examples: [
        'Why does this evidence support the claim?',
        'What is the logic?',
        'How does this reasoning work?',
      ],
    },
    {
      name: 'Counterargument',
      description: 'Opposing viewpoints or objections',
      examples: [
        'What are the objections?',
        'What do critics say?',
        'What are alternative views?',
      ],
    },
    {
      name: 'Rebuttal',
      description: 'Response to counterarguments',
      examples: [
        'How is the objection addressed?',
        'Why is the counterargument wrong?',
        'How is the criticism answered?',
      ],
    },
  ],
};

export const LEGAL_CITATION_TREATMENT_SCHEMA: TagSchema = {
  id: 'legal-citation-treatment',
  name: 'Citation Treatment',
  description: 'Citator-style classification of how a citing case treats the cited case',
  domain: 'legal',
  tags: [
    {
      name: 'positive',
      description: 'The citing case relies on, follows, applies, or extends the cited case',
      examples: [
        'The court relied on Roe v. Wade in reaching its conclusion.',
        'Following Brown v. Board, this Court holds...',
      ],
    },
    {
      name: 'negative',
      description: 'The citing case rejects or disagrees with the cited case (without overruling)',
      examples: [
        'We disagree with the reasoning in Smith v. Jones...',
        'The Court declines to follow Smith...',
      ],
    },
    {
      name: 'distinguished',
      description: 'The citing case acknowledges but distinguishes the cited case on its facts',
      examples: [
        'Smith v. Jones is distinguishable because...',
        'Unlike the defendant in Smith, here...',
      ],
    },
    {
      name: 'criticized',
      description: 'The citing case criticizes the reasoning of the cited case',
      examples: [
        'The reasoning in Smith has been widely criticized...',
        "We doubt the continued vitality of Smith's analysis...",
      ],
    },
    {
      name: 'overruled',
      description: 'The citing case overrules the cited case in part or whole',
      examples: [
        'We overrule Smith v. Jones to the extent it held...',
        'Smith is hereby overruled.',
      ],
    },
    {
      name: 'neutral',
      description: 'A string-cite or background mention with no substantive treatment',
      examples: [
        'See, e.g., Smith v. Jones, 100 U.S. 100 (2000).',
        'Smith v. Jones provides background here.',
      ],
    },
  ],
};

export const ALL_SCHEMAS: TagSchema[] = [
  LEGAL_IRAC_SCHEMA,
  ARGUMENT_TOULMIN_SCHEMA,
  LEGAL_CITATION_TREATMENT_SCHEMA,
];
