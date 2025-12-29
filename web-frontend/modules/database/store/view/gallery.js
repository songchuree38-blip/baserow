import Vue from 'vue'

import bufferedRows from '@baserow/modules/database/store/view/bufferedRows'
import GalleryService from '@baserow/modules/database/services/view/gallery'
import { getRowMetadata } from '@baserow/modules/database/utils/row'

export function populateRow(row, metadata = {}) {
  row._ = {
    metadata: getRowMetadata(row, metadata),
    dragging: false,
  }
  return row
}

const galleryBufferedRows = bufferedRows({
  service: GalleryService,
  customPopulateRow: populateRow,
})

export const state = () => ({
  ...galleryBufferedRows.state(),
})

export const mutations = {
  ...galleryBufferedRows.mutations,
  /**
   * Updates row metadata in the gallery buffer.
   * Deep merges new metadata with existing metadata, removing keys with null values.
   */
  UPDATE_ROW_METADATA(state, { row, metadata }) {
    const index = state.rows.findIndex((item) => item && item.id === row.id)
    if (index !== -1) {
      const existingRowState = state.rows[index]

      // Deep merge new metadata with existing metadata
      const existingMetadata = existingRowState._?.metadata || {}
      const mergedMetadata = { ...existingMetadata }

      // Deep merge each metadata type (e.g., ai_field)
      Object.keys(metadata).forEach((metadataType) => {
        if (!mergedMetadata[metadataType]) {
          mergedMetadata[metadataType] = {}
        }
        // Deep merge field-level metadata, but remove fields with null values
        const newTypeMetadata = { ...mergedMetadata[metadataType] }
        Object.entries(metadata[metadataType]).forEach(([key, value]) => {
          if (value === null) {
            delete newTypeMetadata[key]
          } else {
            newTypeMetadata[key] = value
          }
        })
        mergedMetadata[metadataType] = newTypeMetadata
      })

      // Use single Vue.set to ensure reactivity
      if (!existingRowState._) {
        Vue.set(existingRowState, '_', { metadata: mergedMetadata })
      } else {
        Vue.set(existingRowState._, 'metadata', mergedMetadata)
      }
    }
  },
}

export const actions = {
  ...galleryBufferedRows.actions,
  async fetchInitial(
    { dispatch },
    { viewId, fields, adhocFiltering, adhocSorting }
  ) {
    const data = await dispatch('fetchInitialRows', {
      viewId,
      fields,
      initialRowArguments: { includeFieldOptions: true },
      adhocFiltering,
      adhocSorting,
    })
    await dispatch('forceUpdateAllFieldOptions', data.field_options)
  },
  /**
   * Updates row metadata for specific rows without changing row values.
   * Called when a rows_metadata_updated websocket event is received.
   */
  updateRowMetadata({ commit, getters }, { rowIds, metadata }) {
    const allRows = getters.getRows
    rowIds.forEach((rowId) => {
      const row = allRows.find((r) => r && r.id === rowId)
      if (row) {
        const rowMetadata = metadata[rowId] || {}
        commit('UPDATE_ROW_METADATA', { row, metadata: rowMetadata })
      }
    })
  },
}

export const getters = {
  ...galleryBufferedRows.getters,
}

export default {
  namespaced: true,
  state,
  getters,
  actions,
  mutations,
}
