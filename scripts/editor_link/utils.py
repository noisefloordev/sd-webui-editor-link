from gradio import blocks

def get_blocks_by_id(nodes, result):
    for node in nodes:
        if node.elem_id:
            result[node.elem_id] = node

        if isinstance(node, blocks.BlockContext):
            get_blocks_by_id(node.children, result)

