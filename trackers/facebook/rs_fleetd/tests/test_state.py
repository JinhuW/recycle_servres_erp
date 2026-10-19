"""The agent's files: a cache that survives a crash, configs that a running
container can see change, and an adoption list that round-trips."""

import os
import stat

from rs_fleetd import state


def test_the_desired_state_is_cached_privately_and_atomically(tmp_path):
    state.save_desired(tmp_path, {"authoritative": True, "workers": [{"worker_id": "va-1"}]})

    path = tmp_path / "desired.json"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600  # it holds worker tokens
    assert state.load_desired(tmp_path)["workers"] == [{"worker_id": "va-1"}]
    assert sorted(os.listdir(tmp_path)) == ["desired.json"]  # no temp file left


def test_a_missing_or_corrupt_cache_reads_as_empty_and_not_authoritative(tmp_path):
    assert state.load_desired(tmp_path) == {"authoritative": False, "workers": []}
    (tmp_path / "desired.json").write_text('{"workers": [', encoding="utf-8")
    assert state.load_desired(tmp_path) == {"authoritative": False, "workers": []}
    (tmp_path / "desired.json").write_text('{"workers": "not a list"}', encoding="utf-8")
    assert state.load_desired(tmp_path)["workers"] == []


def test_a_config_is_rewritten_in_place_keeping_its_inode(tmp_path):
    """A running container bind-mounts the file; a rename would be invisible to it."""
    path = state.config_path(tmp_path, "va-1")
    assert state.write_in_place(path, "a = 1\n") is True
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    inode = path.stat().st_ino

    assert state.write_in_place(path, "a = 2\n# longer than before\n") is True
    assert path.stat().st_ino == inode
    assert path.read_text() == "a = 2\n# longer than before\n"
    assert state.write_in_place(path, "b\n") is True
    assert path.read_text() == "b\n"  # truncated, no tail of the old text
    assert state.write_in_place(path, "b\n") is False


def test_file_checksums(tmp_path):
    path = tmp_path / "c.toml"
    assert state.file_sha256(path) is None
    path.write_text("x = 1\n", encoding="utf-8")
    assert state.file_sha256(path) == state.sha256_text("x = 1\n")


def test_adoptions_round_trip(tmp_path):
    adopted = {
        "va-1": {"container": "rs-monitor-va1", "data_dir": "/home/j/configs/sessions/homelab-va1",
                 "cache_volume": "deploy_aimm-home-va1"},
        "homelab-1": {"container": "rs-monitor", "data_dir": '/odd "path"/x', "cache_volume": "deploy_aimm-home"},
    }
    state.save_adopted(tmp_path, adopted)
    assert state.load_adopted(tmp_path) == adopted


def test_an_unreadable_adoption_list_adopts_nothing(tmp_path):
    (tmp_path / "adopt.toml").write_text("[workers.va-1\n", encoding="utf-8")
    assert state.load_adopted(tmp_path) == {}
    (tmp_path / "adopt.toml").write_text('[workers.va-1]\ncontainer = "x"\n', encoding="utf-8")
    assert state.load_adopted(tmp_path) == {}  # incomplete entries are ignored


def test_the_healthcheck_is_installed_executable_under_the_root(tmp_path):
    source = tmp_path / "src.sh"
    source.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    root = tmp_path / "root"
    target = state.install_healthcheck(root, source)
    assert target == root / "healthcheck.sh"
    assert target.read_text() == "#!/bin/sh\nexit 0\n"
    assert stat.S_IMODE(target.stat().st_mode) == 0o755
