import { describe, expect, it } from 'vitest';
import { actionFiles, gitlabIncludes, globTest, localActions } from './pipeline.js';

describe('the files that decide a pipeline', () => {
  it("reads GitLab's local includes in each of their forms, child pipelines' too", () => {
    const named = gitlabIncludes(
      [
        'include:',
        '  - ci/a.yml',
        '  - local: /ci/b.yml',
        "  - local: 'ci/**/*.yml'",
        '  - remote: https://example.com/x.yml',
        '  - https://example.com/y.yml',
        '  - project: other/group',
        '    file: c.yml',
        '  - template: Auto-DevOps.gitlab-ci.yml',
        '  - local: ci/$CI_COMMIT_REF_NAME.yml',
        'child:',
        '  trigger:',
        '    include:',
        '      - local: ci/child.yml',
        'build:',
        '  script: !reference [.setup, script]',
      ].join('\n'),
      'acme/shop',
    );
    expect(named.paths.sort()).toEqual(['ci/a.yml', 'ci/b.yml', 'ci/child.yml']);
    expect(named.patterns.sort()).toEqual(['ci/**.yml', 'ci/**/*.yml']);
    expect(named.unreadable).toBe(false);
    expect(gitlabIncludes('include: ci/one.yml\n', 'acme/shop').paths).toEqual(['ci/one.yml']);
    expect(gitlabIncludes('include: { local: ci/two.yml }\n', 'acme/shop').paths).toEqual([
      'ci/two.yml',
    ]);
    // What cannot be read for certain is refused, not taken for a file that includes nothing.
    expect(gitlabIncludes('a: [unclosed\n', 'acme/shop').unreadable).toBe(true);
  });

  it('reads a file that takes inputs, a large one, and includes of this same project', () => {
    const inputs =
      'spec:\n  inputs:\n    env: {}\n---\ninclude: ci/jobs.yml\nchild:\n  trigger:\n    include: ci/child.yml\n';
    expect(gitlabIncludes(inputs, 'acme/shop').paths.sort()).toEqual([
      'ci/child.yml',
      'ci/jobs.yml',
    ]);
    const jobs = Array.from({ length: 150 }, (_, i) => `job${String(i)}:\n  <<: *d`).join('\n');
    const large = `.d: &d\n  script: make\ninclude: ci/big.yml\n${jobs}\n`;
    expect(gitlabIncludes(large, 'acme/shop')).toMatchObject({
      paths: ['ci/big.yml'],
      unreadable: false,
    });
    const mine = 'include:\n  - project: Acme/Shop\n    ref: $CI_COMMIT_SHA\n    file: ci.yml\n';
    expect(gitlabIncludes(mine, 'acme/shop').unreadable).toBe(true);
    const theirs = 'include:\n  - project: acme/templates\n    file: ci.yml\n';
    expect(gitlabIncludes(theirs, 'acme/shop').unreadable).toBe(false);
    const component = 'include:\n  - component: $CI_SERVER_FQDN/acme/shop/deploy@main\n';
    expect(gitlabIncludes(component, 'acme/shop').unreadable).toBe(true);
    // Another project's component, behind the instance's own name, is another project's.
    const shared = 'include:\n  - component: $CI_SERVER_FQDN/acme/templates/deploy@1.0\n';
    expect(gitlabIncludes(shared, 'acme/shop').unreadable).toBe(false);
    // A variable that may name this same project: no telling, so the proxy refuses.
    for (const text of [
      'include:\n  - project: $CI_PROJECT_PATH\n    file: ci.yml\n',
      'include:\n  - project: ${CI_PROJECT_NAMESPACE}/shop\n    file: ci.yml\n',
      'include:\n  - component: $CI_SERVER_FQDN/$CI_PROJECT_PATH/deploy@main\n',
    ]) {
      expect(gitlabIncludes(text, 'acme/shop').unreadable, text).toBe(true);
    }
  });

  it('matches include patterns as GitLab does', () => {
    expect(globTest('ci/*.yml')('ci/a.yml')).toBe(true);
    expect(globTest('ci/*.yml')('ci/deep/a.yml')).toBe(false);
    expect(globTest('ci/**/*.yml')('ci/deep/a.yml')).toBe(true);
    expect(globTest('ci/*.yml')('ci/a.yml.bak')).toBe(false);
  });

  it('finds the local actions a GitHub workflow uses, and their definitions', () => {
    const text =
      'steps:\n  - uses: ./tools/deploy/\n  - uses: "./"\n  - uses: actions/checkout@v4\n';
    expect(localActions(text).sort()).toEqual(['', 'tools/deploy']);
    expect(actionFiles('')).toEqual(['action.yml', 'action.yaml']);
    expect(actionFiles('tools/deploy')).toEqual([
      'tools/deploy/action.yml',
      'tools/deploy/action.yaml',
    ]);
  });
});
