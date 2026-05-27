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

// provision
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
    assert!(target.exists());
    assert_eq!(handle.branch, "task/T11125");
    assert!(!handle.head.is_empty());
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
    .expect("provision with lock_reason");
    let wts = list_worktrees(ListOpts { repo_root }).expect("list_worktrees");
    let locked_wt = wts
        .iter()
        .find(|w| w.path == target.to_string_lossy().to_string())
        .expect("worktree should appear");
    assert!(locked_wt.is_locked);
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
    assert!(result.is_err());
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
    .expect("first provision");
    let result = provision_worktree(ProvisionOpts {
        repo_root,
        target_path: target.to_string_lossy().to_string(),
        branch: "task/T11125-b".to_string(),
        base_ref: "main".to_string(),
        lock_reason: None,
    });
    assert!(result.is_err());
}

// destroy
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
    .expect("provision");
    let result = destroy_worktree(DestroyOpts {
        repo_root,
        worktree_path: target.to_string_lossy().to_string(),
        force: false,
    })
    .expect("destroy");
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
    .expect("provision with lock");
    let result = destroy_worktree(DestroyOpts {
        repo_root,
        worktree_path: target.to_string_lossy().to_string(),
        force: true,
    });
    assert!(result.is_err());
}

// list
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
    .expect("provision");
    let after = list_worktrees(ListOpts { repo_root }).expect("list");
    assert_eq!(after.len(), before_count + 1);
    assert!(after.iter().any(|w| w.path == target.to_string_lossy().to_string()));
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
    .expect("provision");
    std::fs::remove_dir_all(&target).unwrap();
    let wts = list_worktrees(ListOpts { repo_root }).expect("list");
    assert!(wts.iter().any(|w| w.path == target.to_string_lossy().to_string()));
}

// prune
#[test]
fn prune_worktrees_empty_plan_for_fresh_repo() {
    let repo = init_repo();
    let plan = prune_worktrees(PruneOpts {
        repo_root: repo.path().to_string_lossy().to_string(),
        integration_target: "main".to_string(),
    })
    .expect("prune_worktrees");
    assert_eq!(plan.integration_target, "main");
    assert!(plan.candidates.is_empty());
}

#[test]
fn prune_worktrees_detects_merged_branch() {
    let repo = init_repo();
    let target = repo.path().join("wt-merged-prune");
    let repo_root = repo.path().to_string_lossy().to_string();
    provision_worktree(ProvisionOpts {
        repo_root: repo_root.clone(),
        target_path: target.to_string_lossy().to_string(),
        branch: "task/T11125-prune-merged".to_string(),
        base_ref: "main".to_string(),
        lock_reason: None,
    })
    .expect("provision");
    std::fs::write(target.join("done.txt"), "merged\n").unwrap();
    Command::new("git").args(["add", "done.txt"]).current_dir(&target).status().unwrap();
    Command::new("git").args(["commit", "-q", "-m", "T11125: prune"]).current_dir(&target).status().unwrap();
    Command::new("git").args(["checkout", "main"]).current_dir(&repo).status().unwrap();
    Command::new("git").args(["merge", "--no-ff", "task/T11125-prune-merged", "-m", "integrate"]).current_dir(&repo).status().unwrap();
    let plan = prune_worktrees(PruneOpts {
        repo_root: repo_root.clone(),
        integration_target: "main".to_string(),
    })
    .expect("prune");
    assert!(plan.candidates.iter().any(|c| c.branch.as_deref() == Some("task/T11125-prune-merged")));
    Command::new("git").args(["checkout", "main"]).current_dir(&repo).status().unwrap();
    destroy_worktree(DestroyOpts { repo_root, worktree_path: target.to_string_lossy().to_string(), force: true }).ok();
}

#[test]
fn prune_worktrees_errors_on_invalid_repo() {
    let tmp = TempDir::new().unwrap();
    let result = prune_worktrees(PruneOpts {
        repo_root: tmp.path().to_string_lossy().to_string(),
        integration_target: "main".to_string(),
    });
    assert!(result.is_err());
}

// merge workflow
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
    .expect("provision");
    assert_eq!(handle.branch, "task/T11125-merge");
    std::fs::write(target.join("work-done.txt"), "agent output\n").unwrap();
    Command::new("git").args(["add", "work-done.txt"]).current_dir(&target).status().unwrap();
    Command::new("git").args(["commit", "-q", "-m", "T11125: work"]).current_dir(&target).status().unwrap();
    let branch = "task/T11125-merge";
    let ahead_out = Command::new("git").args(["log", "--format=%H", &format!("main..{branch}")]).current_dir(&repo).output().unwrap();
    let ahead_text = String::from_utf8_lossy(&ahead_out.stdout);
    let ahead_commits: Vec<&str> = ahead_text.lines().filter(|l| !l.is_empty()).collect();
    assert!(!ahead_commits.is_empty());
    let wts = list_worktrees(ListOpts { repo_root: repo_root.clone() }).expect("list");
    let wt = wts.iter().find(|w| w.path == target.to_string_lossy().to_string()).expect("wt");
    assert!(wt.is_locked);
    worktrunk_core::git_wt::unlock_worktree(&PathBuf::from(&repo_root), &target).expect("unlock");
    Command::new("git").args(["checkout", "main"]).current_dir(&repo).status().unwrap();
    let merge = Command::new("git").args(["merge", "--no-ff", branch, "-m", "T11125: integrate"]).current_dir(&repo).output().unwrap();
    assert!(merge.status.success());
    let destroy = destroy_worktree(DestroyOpts { repo_root, worktree_path: target.to_string_lossy().to_string(), force: true });
    assert!(destroy.is_ok());
}
