"""справочник ВЭС Казахстана с координатами турбин

Revision ID: 0004
Revises: 0003
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from app.wind import catalog

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    farms = op.create_table(
        "wind_farms",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("region", sa.String(128), index=True),
        sa.Column("operators", postgresql.JSONB, nullable=False, server_default="[]"),
        sa.Column("capacity_mw", sa.Float),
        sa.Column("capacity_source", sa.String(16)),
        sa.Column("commissioned", sa.String(16)),
        sa.Column("lat", sa.Float),
        sa.Column("lon", sa.Float),
        sa.Column("location", sa.String(16)),
        sa.Column("osm", sa.String(64)),
        sa.Column("in_registry", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("data", sa.String(16), nullable=False, server_default="none"),
        sa.Column("note", sa.Text),
    )
    turbines = op.create_table(
        "wind_turbines",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column(
            "farm_id",
            sa.String(64),
            sa.ForeignKey("wind_farms.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("unit_id", sa.String(16), nullable=False),
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column("lat", sa.Float, nullable=False),
        sa.Column("lon", sa.Float, nullable=False),
        sa.Column("rated_kw", sa.Float),
        sa.Column("model", sa.String(128)),
        sa.Column("osm", sa.String(64)),
        sa.UniqueConstraint("farm_id", "unit_id"),
    )
    catalog.sync(op.get_bind(), farms, turbines)


def downgrade() -> None:
    op.drop_table("wind_turbines")
    op.drop_table("wind_farms")
