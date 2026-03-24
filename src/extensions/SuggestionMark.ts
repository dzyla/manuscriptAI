import { Mark, mergeAttributes } from '@tiptap/core'

export interface SuggestionMarkOptions {
  HTMLAttributes: Record<string, any>
}

export const SuggestionMark = Mark.create<SuggestionMarkOptions>({
  name: 'suggestion',

  addOptions() {
    return {
      HTMLAttributes: {},
    }
  },

  parseHTML() {
    return [
      {
        tag: 'mark[data-suggestion-id]',
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return ['mark', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0]
  },

  addAttributes() {
    return {
      suggestionId: {
        default: null,
        parseHTML: element => element.getAttribute('data-suggestion-id'),
        renderHTML: attributes => {
          if (!attributes.suggestionId) {
            return {}
          }
          return {
            'data-suggestion-id': attributes.suggestionId,
          }
        },
      },
      color: {
        default: null,
        parseHTML: element => element.style.backgroundColor || element.getAttribute('data-color'),
        renderHTML: attributes => {
          if (!attributes.color) {
            return {}
          }
          return {
            'data-color': attributes.color,
            style: `background-color: ${attributes.color};`,
          }
        },
      },
    }
  },

  addCommands() {
    return {
      setSuggestion: attributes => ({ commands }) => {
        return commands.setMark(this.name, attributes)
      },
      toggleSuggestion: attributes => ({ commands }) => {
        return commands.toggleMark(this.name, attributes)
      },
      unsetSuggestion: () => ({ commands }) => {
        return commands.unsetMark(this.name)
      },
    }
  },
})

// Add the commands to the @tiptap/core types
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    suggestion: {
      /**
       * Set a suggestion mark
       */
      setSuggestion: (attributes?: { suggestionId?: string; color?: string }) => ReturnType
      /**
       * Toggle a suggestion mark
       */
      toggleSuggestion: (attributes?: { suggestionId?: string; color?: string }) => ReturnType
      /**
       * Unset a suggestion mark
       */
      unsetSuggestion: () => ReturnType
    }
  }
}
