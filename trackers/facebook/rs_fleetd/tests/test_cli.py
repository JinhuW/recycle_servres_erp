"""The command line: adoption writes the list the agent reads, and a missing
setting is an error message, not a traceback."""

from rs_fleetd import cli, state


def test_adopt_records_the_container_its_session_and_its_cache(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("RS_FLEET_ROOT", str(tmp_path))
    assert cli.main([
        "adopt", "--worker", "va-1", "--container", "rs-monitor-va1",
        "--data-dir", "/home/j/configs/sessions/homelab-va1", "--cache-volume", "deploy_aimm-home-va1",
    ]) == 0
    assert cli.main([
        "adopt", "--worker", "va-2", "--container", "rs-monitor-va2",
        "--data-dir", "/home/j/configs/sessions/homelab-va2", "--cache-volume", "deploy_aimm-home-va2",
    ]) == 0
    adopted = state.load_adopted(tmp_path)
    assert set(adopted) == {"va-1", "va-2"}
    assert adopted["va-1"]["cache_volume"] == "deploy_aimm-home-va1"
    assert "takes over rs-monitor-va2" in capsys.readouterr().out


def test_adopt_refuses_an_id_that_is_not_one(tmp_path, monkeypatch):
    monkeypatch.setenv("RS_FLEET_ROOT", str(tmp_path))
    assert cli.main(["adopt", "--worker", "bad id", "--container", "c", "--data-dir", "/d",
                     "--cache-volume", "v"]) == 2
    assert state.load_adopted(tmp_path) == {}


def test_run_names_what_is_missing(monkeypatch, capsys):
    for name in ("RS_FLEET_URL", "RS_HOST_ID", "RS_HOST_TOKEN", "RS_FLEET_ROOT"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("RS_HOST_ID", "homelab")
    assert cli.main(["run"]) == 2
    err = capsys.readouterr().err
    assert "RS_FLEET_URL" in err and "RS_HOST_TOKEN" in err and "RS_HOST_ID" not in err


def test_settings_come_from_the_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("RS_FLEET_ROOT", str(tmp_path))
    monkeypatch.setenv("RS_FLEET_ENV_FILES", " /etc/a.env, ,/etc/b.env ")
    monkeypatch.setenv("RS_FLEET_VNC_BIND", "10.10.10.74")
    monkeypatch.delenv("RS_FLEET_NETWORK", raising=False)
    settings = cli.settings_from_env()
    assert settings.env_files == ("/etc/a.env", "/etc/b.env")
    assert settings.network == "rs-fleet"
    assert settings.vnc_bind == "10.10.10.74"
