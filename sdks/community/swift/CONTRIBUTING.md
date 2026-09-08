# Contributing to AGUISwift

Thank you for contributing to AGUISwift! This guide will help you understand our development workflow.

## Branch Strategy

We use a feature branch workflow to ensure code quality and enable code review:

- **`main`** - Production-ready code. Protected branch, no direct commits.
- **`feature/*`** - New features (e.g., `feature/agent-memory-system`)
- **`fix/*`** - Bug fixes (e.g., `fix/parsing-edge-case`)
- **`refactor/*`** - Code refactoring (e.g., `refactor/transport-layer`)
- **`docs/*`** - Documentation updates (e.g., `docs/api-examples`)

## Development Workflow

### 1. Create a Feature Branch

Always start from the latest `main`:

```bash
# Update main branch
git checkout main
git pull origin main

# Create and switch to feature branch
git checkout -b feature/your-feature-name

# Or for bug fixes
git checkout -b fix/bug-description
```

### 2. Make Your Changes

Follow our development standards from `CLAUDE.md`:

```bash
# Make changes to code
# Run tests frequently
swift test

# Format code
swift package plugin --allow-writing-to-package-directory swiftformat

# Check for linting issues
swiftlint lint
```

### 3. Commit Your Changes

Use conventional commit messages:

```bash
git add .
git commit -m "feat: add user authentication to HttpAgent

- Implement bearer token authentication
- Add configuration options for auth headers
- Include tests for auth flows

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

**Commit Message Format**:
- `feat:` - New feature
- `fix:` - Bug fix
- `refactor:` - Code refactoring
- `docs:` - Documentation changes
- `test:` - Test additions/updates
- `chore:` - Build/tooling changes

### 4. Push Your Branch

```bash
# First time pushing the branch
git push -u origin feature/your-feature-name

# Subsequent pushes
git push
```

### 5. Create a Pull Request

**Using GitHub CLI** (recommended):

```bash
# Create PR with title and description
gh pr create --title "Add user authentication" --body "$(cat <<'EOF'
## Summary
Implements user authentication for HttpAgent with bearer token support.

## Changes
- Add `AuthenticationProvider` protocol
- Implement `BearerTokenAuth` provider
- Update `HttpAgentConfiguration` with auth options
- Add comprehensive test coverage

## Testing
- [x] Unit tests pass
- [x] Integration tests pass
- [x] SwiftLint passes
- [x] SwiftFormat applied

## Related Issues
Closes #42

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"

# Or create PR interactively
gh pr create
```

**Using GitHub Web UI**:

1. Go to https://github.com/paduh/ag-ui
2. Click "Compare & pull request"
3. Fill in the PR template
4. Click "Create pull request"

### 6. Code Review & Merge

- Wait for CI checks to pass
- Wait for approval from an **approved code reviewer** (required for merge)
- Address any review feedback by making changes and pushing updates
- Once approved by a designated reviewer, the PR can be merged
- Use "Squash and merge" to maintain clean commit history

## Pre-Commit Checklist

Before creating a PR, ensure:

- [ ] All tests pass (`swift test`)
- [ ] Code is formatted (`swift package plugin swiftformat`)
- [ ] No SwiftLint violations in production code (`swiftlint lint`)
- [ ] Documentation is updated
- [ ] Commit messages follow conventions
- [ ] Branch is up to date with `main`

## Syncing with Main

Keep your feature branch up to date:

```bash
# While on your feature branch
git fetch origin
git rebase origin/main

# Or merge if you prefer
git merge origin/main
```

## PR Best Practices

### PR Title
Use the same format as commit messages:
- `feat: add authentication to HttpAgent`
- `fix: resolve UTF-8 boundary handling in SSE parser`
- `refactor: simplify state management actor`

### PR Description Template

```markdown
## Summary
Brief description of what this PR does.

## Changes
- List of main changes
- Each change on a new line
- Be specific and clear

## Testing
- [ ] Unit tests added/updated
- [ ] Integration tests pass
- [ ] Manual testing performed

## Screenshots (if applicable)
[Add screenshots for UI changes]

## Related Issues
Closes #123
Relates to #456

## Checklist
- [ ] Tests pass
- [ ] Code formatted
- [ ] SwiftLint passes
- [ ] Documentation updated
```

## Testing Requirements

All PRs must include tests following TDD principles:

1. **Write tests first** (Red phase)
2. **Implement feature** (Green phase)
3. **Refactor** (Clean phase)

See `CLAUDE.md` for detailed testing guidelines.

## Code Review Guidelines

### For Authors
- Keep PRs focused and small (< 400 lines preferred)
- Respond to feedback promptly
- Be open to suggestions
- Update PR description if scope changes

### For Reviewers

**Note**: Only designated code reviewers with approval permissions can approve PRs for merging.

#### Review Guidelines
- Review within 24-48 hours
- Be constructive and respectful
- Focus on code quality, not personal preferences
- Check that all checklist items are completed
- Verify tests pass and cover new functionality
- Approve only when project standards are met

## Branch Protection Rules

The `main` branch is protected with:
- **Require pull request before merging** - No direct commits to main
- **Require status checks to pass** - All CI checks must be green
- **Require approval from designated code reviewers** - Only approved reviewers can approve PRs
- **Dismiss stale reviews on new commits** - New changes invalidate previous approvals
- **No force pushes** - Protects commit history
- **No deletions** - Branch cannot be deleted

### Setting Up Approved Reviewers

Repository administrators can configure approved reviewers in GitHub:

1. Go to **Settings** → **Branches** → **Branch protection rules**
2. Edit the `main` branch rule
3. Enable **"Require a pull request before merging"**
4. Enable **"Require approvals"** (set to 1 or more)
5. Enable **"Restrict who can approve pull requests"**
6. Add designated reviewers to the approval list

This ensures only trusted reviewers with expertise can approve code for production.

## Emergency Hotfixes

For critical production issues:

```bash
# Create hotfix branch from main
git checkout main
git pull origin main
git checkout -b fix/critical-security-patch

# Make minimal changes
# Test thoroughly
# Create PR with "HOTFIX:" prefix

gh pr create --title "HOTFIX: patch XSS vulnerability"
```

Hotfix PRs can be fast-tracked but still require review.

## Getting Help

- Check `CLAUDE.md` for project standards
- Review existing PRs for examples
- Ask in PR comments if unclear
- Contact maintainers for guidance

## License

By contributing, you agree that your contributions will be licensed under the same license as the project.
