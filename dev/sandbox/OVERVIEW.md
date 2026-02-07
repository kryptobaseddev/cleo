# CLEO Sandbox Testing Environment - Complete Overview

## What You Have Now

A **production-ready, isolated testing environment** for CLEO that functions like a remote server with full SSH access.

## 🎯 Purpose

Test CLEO in production-like conditions without risking your development system:
- Fresh installations
- User onboarding flows
- Multi-project setups
- Bug reproduction
- Pre-release validation

## 📁 File Structure

```
/mnt/projects/claude-todo/dev/sandbox/
├── 📝 Documentation
│   ├── README.md          (9.7KB) - Complete reference guide
│   ├── QUICKSTART.md      (7.8KB) - Getting started guide
│   ├── TESTING-GUIDE.md  (13.0KB) - Testing best practices
│   ├── STATUS.md          (6.8KB) - Implementation status
│   └── OVERVIEW.md             - This file
│
├── 🐳 Container Definition
│   └── Containerfile           - Fedora-based image with CLEO deps
│
├── 🔧 Management Tools
│   ├── sandbox-manager.sh      - Main control script (executable)
│   ├── test-runner.sh          - Automated test suite (executable)
│   └── simple-test.sh          - Basic workflow test (executable)
│
├── 🔐 Security
│   ├── .gitignore              - Excludes SSH keys from git
│   └── ssh/                    - Excluded from git
│
└── 🏠 SSH Keys (Generated on Host)
    ~/.cleo/sandbox/ssh/
    ├── sandbox_key         (600) - Private key
    └── sandbox_key.pub     (644) - Public key
```

## 🚀 Getting Started (3 Steps)

### 1. Navigate to Sandbox Directory
```bash
cd /mnt/projects/claude-todo/dev/sandbox
```

### 2. Start the Sandbox
```bash
./sandbox-manager.sh start
```
This automatically:
- Generates SSH keys (if needed)
- Builds container image (if needed)
- Starts container
- Waits for SSH to be ready

### 3. Connect and Test
```bash
# Interactive shell
./sandbox-manager.sh ssh

# Or run commands directly
./sandbox-manager.sh exec "cleo version"
```

## 🎮 Main Commands

### Lifecycle Management
```bash
./sandbox-manager.sh start     # Start sandbox (builds if needed)
./sandbox-manager.sh stop      # Stop sandbox
./sandbox-manager.sh destroy   # Remove sandbox (keeps image)
./sandbox-manager.sh status    # Show detailed status
```

### Remote Access
```bash
./sandbox-manager.sh ssh           # Interactive SSH session
./sandbox-manager.sh exec "cmd"    # Execute single command
./sandbox-manager.sh logs          # View container logs
./sandbox-manager.sh logs -f       # Follow logs
```

### Testing
```bash
./test-runner.sh                # Run all automated tests
./test-runner.sh workflow       # Run specific test scenario
```

## 📚 Documentation Guide

| File | Purpose | Read When |
|------|---------|-----------|
| **OVERVIEW.md** | Quick introduction (this file) | First time setup |
| **QUICKSTART.md** | Step-by-step setup guide | Getting started |
| **README.md** | Complete reference | Need details on features |
| **TESTING-GUIDE.md** | Testing best practices | Planning test strategy |
| **STATUS.md** | Implementation details | Want technical details |

## 🔍 Common Use Cases

### 1. Test Fresh Installation
```bash
./sandbox-manager.sh start
./sandbox-manager.sh ssh

# Inside sandbox
cd ~/projects
./install.sh
cleo version
```

### 2. Test User Workflow
```bash
./sandbox-manager.sh ssh

# Inside sandbox
mkdir ~/myproject && cd ~/myproject
cleo init

# Bootstrap for multi-session mode (see QUICKSTART.md)
# Then test workflows...
```

### 3. Reproduce Bug
```bash
./sandbox-manager.sh start

# Recreate the conditions
./sandbox-manager.sh exec "cleo add 'Bug reproduction task'"

# Investigate
./sandbox-manager.sh ssh
# ... debug inside sandbox
```

### 4. Pre-Release Testing
```bash
# Run automated test suite
./test-runner.sh

# Manual verification
./sandbox-manager.sh ssh
# ... test critical workflows
```

## ⚙️ How It Works

```
┌─────────────────────────────────────────┐
│  Your Computer (Fedora Desktop)         │
│                                          │
│  Terminal                                │
│    └── sandbox-manager.sh ──────┐       │
│                                 │       │
│  ┌──────────────────────────────┼─────┐ │
│  │  Podman Container           SSH    │ │
│  │  (cleo-sandbox)              │     │ │
│  │                              ▼     │ │
│  │  • Fresh Fedora Linux    Port 2222│ │
│  │  • User: testuser               │ │
│  │  • CLEO installed               │ │
│  │  • All dependencies             │ │
│  │  • Isolated filesystem          │ │
│  │                                  │ │
│  └──────────────────────────────────┘ │
└──────────────────────────────────────────┘
```

**Key Benefits:**
- ✅ **Isolation**: Changes don't affect your system
- ✅ **Reproducibility**: Same environment every time
- ✅ **Safety**: Can't break your development setup
- ✅ **Realism**: Tests in production-like conditions
- ✅ **Speed**: Containers start in seconds

## 🎓 Learning Path

### Beginner
1. Read this OVERVIEW.md
2. Follow QUICKSTART.md to start sandbox
3. Run `./sandbox-manager.sh ssh` and explore
4. Try basic CLEO commands

### Intermediate
1. Read TESTING-GUIDE.md
2. Run automated tests: `./test-runner.sh`
3. Create test projects in sandbox
4. Practice workflows

### Advanced
1. Read full README.md
2. Create custom test scripts
3. Integrate with CI/CD
4. Contribute improvements

## 🔥 Quick Wins

Try these now:

```bash
# 1. Check status
./sandbox-manager.sh status

# 2. Test remote command
./sandbox-manager.sh exec "uname -a"

# 3. Verify CLEO
./sandbox-manager.sh exec "cleo version"

# 4. Interactive exploration
./sandbox-manager.sh ssh
# Inside: cd ~/projects && ls -la
# Type 'exit' to leave
```

## 🛟 Troubleshooting Quick Reference

| Problem | Solution |
|---------|----------|
| Can't connect via SSH | `./sandbox-manager.sh status` to check if running |
| "Permission denied" | SSH keys should be in `~/.cleo/sandbox/ssh/` |
| Container won't start | Check port 2222: `sudo lsof -i :2222` |
| Need fresh start | `./sandbox-manager.sh destroy && ./sandbox-manager.sh start` |

Full troubleshooting: See README.md

## 📊 Current Status

✅ **FULLY OPERATIONAL**

- Container: Running
- SSH: Working
- CLEO: Installed (v0.80.2)
- Tests: Ready
- Documentation: Complete

## 🎯 What's Next?

### Immediate Actions
1. ✅ Sandbox is running - Start testing!
2. 📖 Read QUICKSTART.md for detailed workflows
3. 🧪 Run `./test-runner.sh` to see automated tests
4. 🔍 Explore with `./sandbox-manager.sh ssh`

### Ongoing Use
- Use before each release for validation
- Test new features in isolation
- Reproduce reported bugs
- Validate documentation accuracy

### Contributing
- Report issues found during testing
- Add new test scenarios
- Improve documentation
- Share testing workflows

## 🔗 Related Resources

- **CLEO Main Docs**: `../../docs/`
- **Test Suite**: `../../tests/`
- **GitHub Issues**: Report bugs and suggestions
- **Podman Docs**: https://docs.podman.io/

## 💡 Pro Tips

1. **Start Fresh**: Use `destroy` then `start` for important tests
2. **Save Output**: Pipe test results to files for review
3. **Multiple Terminals**: Run `status` in one, `ssh` in another
4. **Automation**: Integrate into your pre-commit or CI pipeline
5. **Documentation**: Keep notes on what you test and find

## 📝 Summary

You now have a complete, production-ready testing environment that provides:
- **Isolated container** with full SSH access
- **Management scripts** for easy control
- **Automated tests** for quick validation
- **Comprehensive docs** for all scenarios
- **Real production conditions** for accurate testing

**Ready to use!** Start with `./sandbox-manager.sh start`

---

**Questions?** See QUICKSTART.md or README.md for detailed guides.

**Issues?** Check STATUS.md or TESTING-GUIDE.md for troubleshooting.

**Happy Testing! 🚀**
