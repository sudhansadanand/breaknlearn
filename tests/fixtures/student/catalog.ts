/**
 * Synthetic published-catalog fixtures for the student app (PublishedManifest / PublishedLesson
 * shapes from @bnl/contracts). Version ids are fake but valid UUIDs; lesson ids are the canonical
 * MULTIPLICATION_LESSON_IDS.
 */
export const LESSON_IDS: Record<number, string> = {
  1: "02402664-c8e7-5408-ab92-292f6e20a308",
  2: "6a7999d7-caba-5778-87b0-34529b85fdb4",
  3: "f95143b0-7b4c-5452-8a3f-71096a538dff",
  4: "6dcc8a5d-23c4-5a87-8871-17db135101c5",
  5: "e13f93ea-9d02-5a12-bf91-b4fc6554f5a9",
  6: "34ed2bc4-a121-5847-998d-d5d7c227252a",
  7: "2b0028d9-dd24-5020-84f7-c75af77b7b39",
  8: "e2e6e8a9-7da3-540b-a802-346b53f12270",
  9: "a43a1ef5-01d2-5b95-bb56-868c672e70a0",
  10: "c888722d-7b0f-5dc2-b371-41b47d542367",
};

export const versionIdFor = (table: number, versionNo = 1): string => `${String(table).padStart(8, "0")}-0000-4000-8000-${String(versionNo).padStart(12, "0")}`;

export function manifestFixture(tables: number[], opts: { revision?: number; versionNo?: number; playable?: boolean } = {}) {
  const versionNo = opts.versionNo ?? 1;
  return {
    revision: opts.revision ?? 1,
    checksum: `rev-${opts.revision ?? 1}`,
    grade: 2,
    generated_at: "2026-11-14T00:00:00.000Z",
    subjects: [
      { key: "english", label: "English", playable: false, topics: [] },
      {
        key: "math",
        label: "Math",
        playable: opts.playable ?? tables.length > 0,
        topics: [
          {
            id: "58be84d6-b23e-5332-80a7-f7460dd3933f",
            key: "grade2.math.multiplication",
            title: "Multiplication Tables",
            lessons: tables.map((t) => ({
              id: LESSON_IDS[t],
              version_id: versionIdFor(t, versionNo),
              version_no: versionNo,
              stable_key: `grade2.math.multiplication.table-${t}`,
              grade: 2,
              subject_key: "math",
              topic_id: "58be84d6-b23e-5332-80a7-f7460dd3933f",
              title: `${t} Times Table`,
              template_key: "picture_groups_v1",
              sort_order: t,
            })),
          },
        ],
      },
    ],
  };
}

export function lessonFixture(id: string, versionId: string, factor: number, config: Record<string, unknown>, versionNo = 1) {
  return {
    id,
    version_id: versionId,
    version_no: versionNo,
    checksum: `c-${versionId}`,
    published_at: "2026-11-14T00:00:00.000Z",
    content: {
      contract_version: 1,
      stable_key: `grade2.math.multiplication.table-${factor}`,
      grade: 2,
      subject_key: "math",
      topic_key: "grade2.math.multiplication",
      title: `${factor} Times Table`,
      template: "picture_groups_v1",
      config: { factor, count_from: 1, count_to: 10, themes: ["puppy", "candy", "unicorn", "school", "treat", "farm"], seconds_per_slide: 7, quiz_question_count: 3, ...config },
      learning_outcome_keys: ["grade2.math.multiplication"],
      rights: { type: "original_generated_content", reviewed: true },
    },
  };
}

/** lessonFixture for table `t` in a manifest built by manifestFixture. */
export const lessonForTable = (t: number, config: Record<string, unknown> = {}, versionNo = 1) => lessonFixture(LESSON_IDS[t]!, versionIdFor(t, versionNo), t, config, versionNo);
