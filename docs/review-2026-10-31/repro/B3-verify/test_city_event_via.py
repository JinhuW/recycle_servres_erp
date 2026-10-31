"""B3-02 repro: the ERP fleet hands `why` in {probe, manual, familiar, other};
the worker posts it as `via` on `started`; the coordinator schema rejects it."""
import pytest
from pydantic import ValidationError
from rs_coordinator.schemas import CityEventReport

@pytest.mark.parametrize("via", ["queue", "own"])
def test_legacy_via_accepted(via):
    CityEventReport(item="server_ram", city="nyc", event="started", via=via, searches=3)

@pytest.mark.parametrize("via", ["other", "familiar", "manual", "probe"])
def test_fleet_task_via_rejected(via):
    with pytest.raises(ValidationError):
        CityEventReport(item="server_ram", city="nyc", event="started", via=via, searches=3)
