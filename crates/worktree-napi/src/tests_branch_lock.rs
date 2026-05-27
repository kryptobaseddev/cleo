// SPDX-License-Identifier: MIT
// Copyright (c) 2026 kryptobaseddev
//
// Branch-lock NAPI test coverage for provision, destroy, list, prune,
// and merge workflow operations (T11125).

use super::*;
use std::process::Command;
use tempfile::TempDir;

fn init_repo() -> TempDir {
    let dir = TempDir::new().unwrap();
    let p = dir.path();
    Command::new("git")
        .args(["init", "-q", "-b", "main"])
        .current_dir(p)
        .status()
        .unwrap();
    Command::new("git")
        .args(["config", "user.email", "t@t.t"])
        .current_dir(p)
        .status()
        .unwrap();
    Command::new("git")
        .args(["config", "user.name", "t"])
        .current_dir(p)
        .status()
        .unwrap();
    std::fs::write(p.join("README.md"), "init\n").unwrap();
    Command::new("git")
        .args(["add", "README.md"])
        .current_dir(p)
        .status()
        .unwrap();
    Command::new("git")
        .args(["commit", "-q", "-m", "init"])
        .current_dir(p)
        .status()
        .unwrap();
    dir
}

// ── provision_worktree tests ─────────────────────────────────────

#[test]
fn provision_worktree_success() {
    let repo = init_repo();
    let target = repo.path().join("wt-task-T11125");
    let repo_root = repo.path().to_string_lossy().to_string();

    let handle = provision_worktree(ProvisionOpts {
        repo_root,
        target_path: target.to_string_lossy().to_string(),
        branch: "task/T11125".to_string(),
        base_ref: "main".to_string(),
        lock_reason: None,
    })
    .expect("provision_worktree should succeed on a fresh repo");

    assert!(target.exists(), "worktree directory should exist");
    assert_eq!(handle.branch, "task/T11125");
    assert!(!handle.head.is_empty(), "head should be a commit SHA");
}

#[test]
fn provision_worktree_with_lock_reason() {
    let repo = init_repo();
    let target = repo.path().join("wt-locked-T11125");
    let repo_root = repo.path().to_string_lossy().to_string();

    provision_worktree(ProvisionOpts {
        repo_root: repo_root.clone(),
        target_path: target.to_string_lossy().to_string(),
        branch: "task/T11125-locked".to_string(),
        base_ref: "main".to_string(),
        lock_reason: Some("cleo-agent-T11125".to_string()),
    })
    .expect("provision_worktree with lock_reason should succeed");

    // Verify locked status.
    let wts = list_worktrees(ListOpts { repo_root }).expect("list_worktrees should succeed");
    let locked_wt = wts
        .iter()
        .find(|w| w.path == target.to_string_lossy().to_string())
        .expect("provisioned worktree should appear in list");
    assert!(locked_wt.is_locked, "locked worktree should report is_locked");
}

#[test]
fn provision_worktree_errors_on_invalid_repo() {
    let tmp = TempDir::new().unwrap();
    let result = provision_worktree(ProvisionOpts {
        repo_root: tmp.path().to_string_lossy().to_string(),
        target_path: tmp.path().join("wt").to_string_lossy().to_string(),
        branch: "task/T11125".to_string(),
        base_ref: "main".to_string(),
        lock_reason: None,
    });
    assert!(result.is_err(), "should fail on a non-git directory");
}

#[test]
fn provision_worktree_errors_on_conflicting_target() {
    let repo = init_repo();
    let target = repo.path().join("wt-conflict");
    let repo_root = repo.path().to_string_lossy().to_string();

    provision_worktree(ProvisionOpts {
        repo_root: repo_root.clone(),
        target_path: target.to_string_lossy().to_string(),
        branch: "task/T11125-a".to_string(),
        base_ref: "main".to_string(),
        lock_reason: None,
    })
    .expect("first provision should succeed");

    let result = provision_worktree(ProvisionOpts {
        repo_root,
        target_path: target.to_string_lossy().to_string(),
        branch: "task/T11125-b".to_string(),
        base_ref: "main".to_string(),
        lock_reason: None,
    });
    assert!(result.is_err(), "should fail on already-occupied target");
}

// ── destroy_worktree tests ────────────────────────────────────────

#[test]
fn destroy_worktree_success() {
    let repo = init_repo();
    let target = repo.path().join("wt-to-destroy");
    let repo_root = repo.path().to_string_lossy().to_string();

    provision_worktree(ProvisionOpts {
        repo_root: repo_root.clone(),
        target_path: target.to_string_lossy().to_string(),
        branch: "task/T11125-del".to_string(),
        base_ref: "main".to_string(),
        lock_reason: None,
    })
    .expect("provision should succeed");

    let result = destroy_worktree(DestroyOpts {
        repo_root: repo_root.clone(),
        worktree_path: target.to_string_lossy().to_string(),
        force: false,
    })
    .expect("destroy_worktree should succeed on an unlocked worktree");

    assert!(result.removed);
    assert!(!target.exists());
}

#[test]
fn destroy_worktree_fails_on_locked_worktree() {
    let repo = init_repo();
    let target = repo.path().join("wt-locked-destroy");
    let repo_root = repo.path().to_string_lossy().to_string();

    provision_worktree(ProvisionOpts {
        repo_root: repo_root.clone(),
        target_path: target.to_string_lossy().to_string(),
        branch: "task/T11125-locked-del".to_string(),
        base_ref: "main".to_string(),
        lock_reason: Some("cleo-agent-T11125".to_string()),
    })
    .expect("provision with lock should succeed");

    // Even with force=true, locked worktrees need -f -f (git 2.x behavior).
    // The binding passes single --force.
    let result = destroy_worktree(DestroyOpts {
        repo_root,
        worktree_path: target.to_string_lossy().to_string(),
        force: true,
    });
    assert!(
        result.is_err(),
        "even force=true fails on locked worktree (git requires -f -f)"
    );
}

// ── list_worktrees tests ──────────────────────────────────────────

#[test]
fn list_worktrees_includes_provisioned_worktrees() {
    let repo = init_repo();
    let target = repo.path().join("wt-list-test");
    let repo_root = repo.path().to_string_lossy().to_string();

    let before = list_worktrees(ListOpts {
        repo_root: repo_root.clone(),
    })
    .expect("list_worktrees");
    let before_count = before.len();

    provision_worktree(ProvisionOpts {
        repo_root: repo_root.clone(),
        target_path: target.to_string_lossy().to_string(),
        branch: "task/T11125-list".to_string(),
        base_ref: "main".to_string(),
        lock_reason: None,
    })
    .expect("provision should succeed");

    let after = list_worktrees(ListOpts { repo_root }).expect("list_worktrees after provision");
    assert_eq!(after.len(), before_count + 1);
    assert!(
        after
            .iter()
            .any(|w| w.path == target.to_string_lossy().to_string())
    );
}

#[test]
fn list_worktrees_handles_missing_directory() {
    let repo = init_repo();
    let target = repo.path().join("wt-prunable");
    let repo_root = repo.path().to_string_lossy().to_string();

    provision_worktree(ProvisionOpts {
        repo_root: repo_root.clone(),
        target_path: target.to_string_lossy().to_string(),
        branch: "task/T11125-prune".to_string(),
        base_ref: "main".to_string(),
        lock_reason: None,
    })
    .expect("provision should succeed");

    // Remove directory to simulate a pruned worktree.
    std::fs::remove_dir_all(&target).unwrap();

    let wts = list_worktrees(ListOpts { repo_root }).expect("list_worktrees");
    let entry = wts
        .iter()
        .find(|w| w.path == target.to_string_lossy().to_string());
    assert!(
        entry.is_some(),
        "worktree should still appear after directory removed"
    );
}

// ── prune_worktrees tests ─────────────────────────────────────────

#[test]
fn prune_worktrees_returns_empty_plan_for_fresh_repo() {
    let repo = init_repo();
    let repo_root = repo.path().to_string_lossy().to_string();

    let plan = prune_worktrees(PruneOpts {
        repo_root,
        integration_target: "main".to_string(),
    })
    .expect("prune_worktrees should succeed on fresh repo");

    assert_eq!(plan.integration_target, "main");
    assert!(
        plan.candidates.is_empty(),
        "fresh repo should have no prune candidates"
    );
}

#[test]
fn prune_worktrees_detects_merged_branch_worktree() {
    let repo = init_repo();
    let target = repo.path().join("wt-merged-prune");
    let repo_root = repo.path().to_string_lossy().to_string();

    // Provision + commit work.
    provision_worktree(ProvisionOpts {
        repo_root: repo_root.clone(),
        target_path: target.to_string_lossy().to_string(),
        branch: "task/T11125-prune-merged".to_string(),
        base_ref: "main".to_string(),
        lock_reason: None,
    })
    .expect("provision should succeed");

    std::fs::write(target.join("done.txt"), "merged work\n").unwrap();
    Command::new("git")
        .args(["add", "done.txt"])
        .current_dir(&target)
        .status()
        .unwrap();
    Command::new("git")
        .args(["commit", "-q", "-m", "T11125: prune candidate"])
        .current_dir(&target)
        .status()
        .unwrap();

    // Merge back into main.
    Command::new("git")
        .args(["checkout", "main"])
        .current_dir(&repo)
        .status()
        .unwrap();
    Command::new("git")
        .args([
            "merge",
            "--no-ff",
            "task/T11125-prune-merged",
            "-m",
            "integrate T11125 prune candidate",
        ])
        .current_dir(&repo)
        .status()
        .unwrap();

    let plan = prune_worktrees(PruneOpts {
        repo_root: repo_root.clone(),
        integration_target: "main".to_string(),
    })
    .expect("prune_worktrees should succeed");

    // The merged worktree branch should appear as a candidate.
    let has_candidate = plan
        .candidates
        .iter()
        .any(|c| c.branch.as_deref() == Some("task/T11125-prune-merged"));
    assert!(
        has_candidate,
        "merged branch should appear as a prune candidate"
    );

    // Cleanup: destroy the worktree so TempDir can drop cleanly.
    Command::new("git")
        .args(["checkout", "main"])
        .current_dir(&repo)
        .status()
        .unwrap();
    destroy_worktree(DestroyOpts {
        repo_root,
        worktree_path: target.to_string_lossy().to_string(),
        force: true,
    })
    .ok();
}

#[test]
fn prune_worktrees_errors_on_invalid_repo_branch_lock() {
    let tmp = TempDir::new().unwrap();
    let result = prune_worktrees(PruneOpts {
        repo_root: tmp.path().to_string_lossy().to_string(),
        integration_target: "main".to_string(),
    });
    assert!(
        result.is_err(),
        "should fail on a non-git directory"
    );
}

// ── merge workflow end-to-end test ───────────────────────────────

#[test]
fn merge_workflow_provision_commit_and_verify() {
    let repo = init_repo();
    let target = repo.path().join("wt-merge-workflow");
    let repo_root = repo.path().to_string_lossy().to_string();

    let handle = provision_worktree(ProvisionOpts {
        repo_root: repo_root.clone(),
        target_path: target.to_string_lossy().to_string(),
        branch: "task/T11125-merge".to_string(),
        base_ref: "main".to_string(),
        lock_reason: Some("cleo-agent-T11125-merge".to_string()),
    })
    .expect("provision should succeed");

    assert_eq!(handle.branch, "task/T11125-merge");

    // Simulate agent work.
    std::fs::write(target.join("work-done.txt"), "agent output\n").unwrap();
    Command::new("git")
        .args(["add", "work-done.txt"])
        .current_dir(&target)
        .status()
        .unwrap();
    Command::new("git")
        .args(["commit", "-q", "-m", "T11125: agent work complete"])
        .current_dir(&target)
        .status()
        .unwrap();

    // Verify branch is ahead of main.
    let branch = "task/T11125-merge";
    let ahead_out = Command::new("git")
        .args(["log", "--format=%H", &format!("main..{branch}")])
        .current_dir(&repo)
        .output()
        .unwrap();
    let ahead_text = String::from_utf8_lossy(&ahead_out.stdout);
    let ahead_commits: Vec<&str> = ahead_text.lines().filter(|l| !l.is_empty()).collect();
    assert!(!ahead_commits.is_empty(), "branch should have commits ahead of main");

    // Verify worktree is locked.
    let wts = list_worktrees(ListOpts {
        repo_root: repo_root.clone(),
    })
    .expect("list_worktrees");
    let wt = wts
        .iter()
        .find(|w| w.path == target.to_string_lossy().to_string())
        .expect("worktree should appear in list");
    assert!(wt.is_locked, "active worktree should be locked");

    // Unlock and merge into main via the git CLI to verify the merge workflow.
    worktrunk_core::git_wt::unlock_worktree(&PathBuf::from(&repo_root), &target)
        .expect("unlock should succeed");

    Command::new("git")
        .args(["checkout", "main"])
        .current_dir(&repo)
        .status()
        .unwrap();
    let merge = Command::new("git")
        .args(["merge", "--no-ff", branch, "-m", "T11125: integrate agent work"])
        .current_dir(&repo)
        .output()
        .unwrap();
    assert!(
        merge.status.success(),
        "merge --no-ff should succeed: {}",
        String::from_utf8_lossy(&merge.stderr)
    );

    // After merge, worktree cleanup should succeed.
    let destroy = destroy_worktree(DestroyOpts {
        repo_root,
        worktree_path: target.to_string_lossy().to_string(),
        force: true,
    });
    assert!(destroy.is_ok(), "destroy after merge should succeed");
}
