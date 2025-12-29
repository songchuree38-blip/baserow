# Field Metadata System

## Overview

The field metadata system provides a way to store and manage per-field, per-row metadata in Baserow tables. This metadata is stored separately from the actual field values and is used to track additional information about fields that doesn't belong in the primary data model.

**Primary use case**: Tracking AI field generation status (generating, success, error) with timestamps and error details.

## Architecture

### Storage Layer

#### Database Schema

Metadata is stored in a JSONB column named `field_metadata` on each table. New tables automatically include this column. For existing tables, the column is added when first needed by a field type that uses metadata:

```sql
ALTER TABLE database_table_123
ADD COLUMN field_metadata JSONB NOT NULL DEFAULT '{}';
```

The column is automatically included in the table model when `field_metadata_column_added=True` (default for all tables after migration 0202). A GIN index is automatically created on the column for efficient JSONB containment and existence queries.

**Internal storage format** (in database):
```json
{
  "456": {  // field_id as string - GENERATING state
    "start": 1762348609.808954   // generation started (Unix timestamp)
  },
  "457": {  // ERROR state
    "start": 1762348610.123456,
    "end": 1762348612.789012,
    "ok": false,
    "error": "API timeout"        // error message (only when ok=false)
  },
  "458": {  // SUCCESS state (not returned in API)
    "start": 1762348620.123456,
    "end": 1762348625.789012,
    "ok": true
  }
}
```

**API format** (transformed for frontend):
```json
{
  "456": {"status": "generating"},  // has start, no end
  "457": {"status": "error"}        // has end, ok=false
  // 458 not included - success state is not returned
}
```

Status is derived from the internal format:
- Has `start` but no `end` → `"generating"`
- Has `end` with `ok=true` → not returned (success = absence of metadata)
- Has `end` with `ok=false` → `"error"`

**Key design decisions**:
- Field IDs are stored as strings (JSON requirement)
- Human-readable keys in storage for maintainability
- JSONB allows efficient querying and atomic updates
- Default empty object `{}` avoids NULL handling
- Status derived from timestamps/flags, not stored directly

#### Column Management

The `field_metadata` column is automatically included for all tables:

```python
from baserow.contrib.database.fields.metadata_handler import FieldMetadataHandler

# Check if metadata is available
model = table.get_model()
if FieldMetadataHandler.is_metadata_available(model):
    # Column exists, safe to use metadata operations
```

**Table model tracking**: The `Table` model has a `field_metadata_column_added` boolean flag (defaults to `True` after migration 0202) that determines whether the column is included in the generated model.

### Core Components

#### 1. FieldMetadataHandler

**Location**: `backend/src/baserow/contrib/database/fields/metadata_handler.py`

Generic handler providing CRUD operations for field metadata. See the source file for method signatures.

**Key features**:
- Uses PostgreSQL's `jsonb_set` with `COALESCE` for atomic updates, avoiding race conditions
- Custom Django ORM `Func` class (`JSONBRemoveKey`) for JSONB `-` operator to remove keys atomically
- All methods gracefully degrade when metadata column doesn't exist


#### 2. Field-Specific Handlers

Field types can implement handlers with domain-specific logic.

**Example: AIFieldMetadataHandler**

**Location**: `premium/backend/src/baserow_premium/fields/ai_field_metadata.py`

Provides AI-specific methods for managing generation status:
- Set rows to "generating" state (clears any previous state)
- Combined helper that sets status AND broadcasts WebSocket update (preferred method)
- Mark as successful with completion timestamp
- Mark as failed with error details
- Clear metadata for rows (when batch fails midway)
- Broadcast metadata updates via WebSocket

**Status enum** (`AIGenerationStatus`): `GENERATING`, `SUCCESS`, `ERROR` (derived from metadata presence)

**Metadata keys** (`AIMetadataKeys`): Human-readable storage names (`"start"`, `"end"`, `"ok"`, `"error"`)

See the source file for method signatures and implementation details.

### API Integration

#### Row Metadata Registry

**Location**: `backend/src/baserow/contrib/database/rows/registries.py`

The `row_metadata_registry` provides a plugin system for exposing metadata via the API.

**Implementation example**: `premium/backend/src/baserow_premium/fields/row_metadata_types.py`

The `AIFieldMetadataType` class:
1. Extends `RowMetadataType` base class
2. Fetches metadata from database for specified rows
3. Transforms internal format to API format
4. Provides API documentation via serializer field

**Registration**: In app's `ready()` method (`premium/backend/src/baserow_premium/apps.py`):
```python
row_metadata_registry.register(AIFieldMetadataType())
```

#### API Usage

Metadata is opt-in via the `?include=row_metadata` query parameter:

**Grid view request**:
```
GET /api/database/views/grid/123/?include=row_metadata
```

**Response**:
```json
{
  "count": 10,
  "results": [
    {
      "id": 456,
      "field_789": "Generated text value"
    }
  ],
  "row_metadata": {
    "456": {
      "ai_field": {
        "789": {"status": "generating"}
      },
      "row_comment_count": 3
    }
  }
}
```

**AI field metadata format**:
- `{"status": "generating"}` - AI is currently generating a value
- `{"status": "error"}` - Generation failed
- No metadata returned for success state (absence = success or never generated)

**Supported endpoints**:
- Grid view: `GET /api/database/views/grid/{view_id}/`
- Gallery view: `GET /api/database/views/gallery/{view_id}/`
- Kanban view: `GET /api/database/views/kanban/{view_id}/` (premium)
- Calendar view: `GET /api/database/views/calendar/{view_id}/` (premium)
- Timeline view: `GET /api/database/views/timeline/{view_id}/` (premium)

All use `@allowed_includes("field_options", "row_metadata")` decorator.

### Real-time Updates

#### Websocket Messages

The system provides real-time metadata updates via websockets.

**New signal**: `rows_metadata_updated` in `backend/src/baserow/contrib/database/rows/signals.py`

**Implementation**: `backend/src/baserow/contrib/database/ws/rows/signals.py`

The signal handler:
1. Listens for `rows_metadata_updated` signal
2. Fetches latest metadata from database via `row_metadata_registry`
3. Broadcasts `rows_metadata_updated` websocket message with metadata
4. Uses `transaction.on_commit()` to ensure consistency

**Broadcasting helper**: `AIFieldMetadataHandler.broadcast_generation_started()`

This method broadcasts metadata updates to connected clients:
```python
# Set metadata in database
AIFieldMetadataHandler.set_generating(ai_field, row_ids)

# Broadcast to all connected clients
AIFieldMetadataHandler.broadcast_generation_started(
    ai_field=ai_field,
    row_ids=row_ids,
    user=user,
)
```

**Manual signal usage** (for custom metadata types):
```python
from baserow.contrib.database.rows.signals import rows_metadata_updated

rows_metadata_updated.send(
    sender=self,
    table=table,
    row_ids=[row.id],
    user=user,
)
```

#### Websocket Message Flow

**Scenario: AI field generation**

1. **User triggers generation** (API call)
   ```
   POST /api/database/fields/789/generate-ai-values/
   ```
   - Returns `HTTP 202 ACCEPTED`
   - Celery task enqueued

2. **Task starts, metadata updated to "generating"**
   ```python
   # Use combined helper (preferred) - sets metadata AND broadcasts
   AIFieldMetadataHandler.set_generating_and_broadcast(
       ai_field, row_ids, user
   )
   ```

   **Websocket broadcast**:
   ```json
   {
     "type": "rows_metadata_updated",
     "table_id": 100,
     "row_ids": [456],
     "metadata": {
       "456": {
         "ai_field": {
           "789": {"status": "generating"}
         }
       }
     }
   }
   ```

3. **AI generates value**

4. **Task completes successfully**
   ```python
   with transaction.atomic():
       AIFieldMetadataHandler.set_success(model, row.id, field.id)
       RowHandler().update_row_by_id(...)  # Triggers rows_updated signal
   ```

   **Websocket broadcast** (via existing `rows_updated` signal):
   ```json
   {
     "type": "rows_updated",
     "table_id": 100,
     "rows": [{"id": 456, "field_789": "Generated text..."}],
     "metadata": {},
     "updated_field_ids": [789]
   }
   ```

   Note: Success state returns empty metadata for the AI field (absence = success).

5. **On error**
   ```python
   AIFieldMetadataHandler.set_error(model, row.id, field.id, str(exc))
   rows_metadata_updated.send(...)
   ```

   **Websocket broadcast**:
   ```json
   {
     "type": "rows_metadata_updated",
     "table_id": 100,
     "row_ids": [456],
     "metadata": {
       "456": {
         "ai_field": {
           "789": {"status": "error"}
         }
       }
     }
   }
   ```

   Note: Error details (message, type) are stored internally but not exposed in the API.

#### Message Type Comparison

| Event | Signal | Includes Row Values | Includes Metadata | Use Case |
|-------|--------|---------------------|-------------------|----------|
| `rows_created` | `rows_created` | ✅ Yes | ✅ Yes | New row added |
| `rows_updated` | `rows_updated` | ✅ Yes | ✅ Yes | Row values changed |
| `rows_deleted` | `rows_deleted` | ✅ Yes | ❌ No | Row deleted |
| `rows_metadata_updated` | `rows_metadata_updated` | ❌ No | ✅ Yes | **Metadata changed without value change** |

**Key insight**: `rows_metadata_updated` is for metadata-only changes, avoiding unnecessary row value serialization and frontend re-renders.

## Implementation Example: AI Field Generation

### Complete Lifecycle

**Reference implementation**: `premium/backend/src/baserow_premium/fields/job_types.py`

The AI field generation job (`GenerateAIValuesJobType` with `AIValueGenerator`) demonstrates the complete metadata lifecycle:

1. **API trigger**: User calls generate endpoint, which invokes `AIFieldHandler.start_ai_field_generation()`:
   - Validates rows exist and AI model is available
   - Calls `AIFieldMetadataHandler.set_generating_and_broadcast()` to set status and notify clients
   - Creates async job via `JobHandler().create_and_start_job()`

2. **Job execution**: `GenerateAIValuesJobType.run()` creates an `AIValueGenerator` instance:
   - Checks metadata availability using `FieldMetadataHandler.is_metadata_available()`
   - Processes rows in chunks, setting "generating" status for each chunk before processing
   - Uses concurrent threads (controlled by `ai_max_concurrent_generations`) for AI calls

3. **Per-row processing** (in `AIValueGenerator`):
   - **On success**: Calls `AIFieldMetadataHandler.set_success()` then `RowHandler().update_row_by_id()` which triggers `rows_updated` signal with the new value
   - **On error**: Calls `AIFieldMetadataHandler.set_error()` and sends `rows_metadata_updated` signal

4. **Cleanup on cancellation/error**: `_cleanup_unprocessed_rows()` clears "generating" status from rows that were marked but never processed

**Critical detail**: Success metadata must be set **before** `update_row_by_id()`. This ensures the `rows_updated` signal includes the correct metadata state (success = no AI field metadata returned).

## Use Cases

### Current: AI Field Generation Status

- Track when AI generation starts, completes, or fails
- Display loading spinners in UI
- Show error messages to users
- Support page refresh (metadata persists in database)
- Real-time collaboration (other users see generation status)

### Future Possibilities

The metadata system can be extended to support various use cases:

#### Validation State
Track field validation status (validating → valid/invalid) with error details and timestamps.

#### Computation Cache
Store computation status and cache keys for expensive field calculations, enabling smart cache invalidation.

#### Import/Sync Status
Track synchronization with external systems (syncing → synced/failed) including source information and last sync timestamps.

#### Data Quality Metrics
Store data quality scores, completeness metrics, or confidence levels for fields that aggregate or derive information.

Each use case would follow the same pattern as `AIFieldMetadataHandler`:
1. Define status enum and metadata keys
2. Create handler class with state management methods
3. Implement `RowMetadataType` for API exposure
4. Send `rows_metadata_updated` signals for real-time updates

## Design Patterns

### 1. Graceful Degradation

Always check if metadata is available before using:

```python
if FieldMetadataHandler.is_metadata_available(model):
    # Safe to use metadata
    AIFieldMetadataHandler.set_generating(ai_field, row.id)
else:
    # Column doesn't exist yet, skip metadata
    pass
```

### 2. Readable Keys with Constants

Use constants for keys to enable refactoring while keeping storage readable:

```python
class MyMetadataKeys:
    START = "start"        # When operation started
    END = "end"            # When operation completed
    OK = "ok"              # True=success, False=error
    ERROR = "error"        # Error message (only when ok=False)

# In code (using constants)
metadata = {
    MyMetadataKeys.START: timezone.now().timestamp(),
}

# In database (human-readable)
{"start": 1762348609.808954}
```

This approach prioritizes debuggability over storage space (which is rarely a concern for metadata).

### 3. Atomic Transactions for Consistency

When updating both row values and metadata, use a transaction:

```python
with transaction.atomic():
    # Update metadata first
    FieldMetadataHandler.set_metadata(...)

    # Then update row (this triggers signals)
    RowHandler().update_row_by_id(...)

# Both committed together, signal fires with correct metadata
```

### 4. Preserve Existing Metadata

When updating status, preserve timestamps:

```python
# Use merge=True for atomic updates that preserve existing keys
FieldMetadataHandler.set_metadata(
    model,
    [MetadataUpdate(
        row_id=row_id,
        field_id=field_id,
        metadata={
            MyMetadataKeys.STATUS: "completed",
            MyMetadataKeys.FINISHED_AT: timezone.now().timestamp(),
        }
    )],
    merge=True  # Uses jsonb_set for atomic merge
)
```

### 5. Cleanup on Field Operations

Metadata is automatically cleaned up when fields are deleted or modified. The `FieldHandler` calls lifecycle hooks on `FieldMetadataHandler` during field deletion and type changes, ensuring no orphaned metadata remains.

## Performance Considerations

### Database Queries

- **GIN indexes** on JSONB columns enable fast queries
- **Atomic updates** via `jsonb_set` avoid race conditions
- **Bulk operations** available for multi-row updates

### API Performance

- **Opt-in metadata**: Only loaded when `?include=row_metadata` is specified
- **Registry pattern**: Multiple metadata types can coexist efficiently
- **Single query**: All metadata types fetched in one pass

### Websocket Performance

- **Deferred broadcasting**: Uses `transaction.on_commit()` to ensure data consistency
- **Targeted updates**: Only affected rows notified
- **Lightweight messages**: Metadata-only updates skip row value serialization


## Known Limitations

The field metadata system is currently in its initial implementation phase. The following limitations exist:

### Not Yet Supported

1. **Undo/Redo**: Metadata changes are not tracked by the undo/redo system
   - Undoing a row update will not restore previous metadata
   - Metadata changes happen outside the action history tracking

2. **Import/Export**: Metadata is not included in table exports
   - CSV/JSON/XML exports only contain field values, not metadata
   - Importing data will not restore metadata from previous exports
   - Duplicating tables/rows will not copy metadata

3. **Snapshots**: Metadata is not included in table snapshots
   - Restoring a snapshot will not restore metadata states
   - Metadata is treated as ephemeral, not part of the data model

4. **Field Duplication**: When duplicating fields, metadata is NOT copied
   - Metadata is field-specific and tied to field IDs
   - Duplicated fields get new IDs, so old metadata doesn't apply
   - New field instances start with empty metadata
   - This is by design - metadata tracks current state, not historical field configurations

5. **Row History**: Metadata changes are not tracked in row history
   - Viewing historical row versions will not show metadata at that time
   - Only current metadata state is available

6. **Webhooks**: Metadata changes do not trigger webhooks
   - Metadata is internal system state, not user data
   - Only row value changes trigger webhooks


### Design Considerations

- **Ephemeral nature**: Metadata is intentionally designed as supplementary information that tracks current state, not historical data

### When to Use Metadata vs. Regular Fields

**Use metadata for**:
- Temporary state (generation status, validation state)
- System-generated information (timestamps, error messages)
- UI-only information that doesn't need to be exported
- Information that changes frequently and doesn't need history

## Summary

The field metadata system provides:

1. **Flexible storage** via JSONB column
2. **Type-safe access** via handler classes
3. **API integration** via registry pattern
4. **Real-time updates** via websocket signals
5. **Efficient querying** via GIN indexes
6. **Atomic operations** via PostgreSQL functions
7. **Extensible design** for future metadata types

The system is currently used for AI field generation status tracking but can be extended to support validation states, computation caching, sync status, and other per-field, per-row metadata needs.
