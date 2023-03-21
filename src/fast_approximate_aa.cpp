#include "fast_approximate_aa.h"
#include "deferred_shading.h"
#include "ray_traced_ao.h"
#include "ray_traced_shadows.h"
#include "ray_traced_reflections.h"
#include "ddgi.h"
#include "ground_truth_path_tracer.h"
#include "utilities.h"
#include <imgui.h>
#include <profiler.h>
#include <macros.h>

// -----------------------------------------------------------------------------------------------------------------------------------

struct FastApproximateAAConstant
{
    float AbsoluteLumaThreshold;
    float RelativeLumaThreshold;
    float ConsoleCharpness;
    float DebugMode;
};

// -----------------------------------------------------------------------------------------------------------------------------------

FastApproximateAA::FastApproximateAA(std::weak_ptr<dw::vk::Backend> backend, CommonResources* common_resources) :
        m_backend(backend), m_common_resources(common_resources)
{
    auto vk_backend = backend.lock();

    m_width  = vk_backend->swap_chain_extents().width;
    m_height = vk_backend->swap_chain_extents().height;

    create_pipeline();
}

// -----------------------------------------------------------------------------------------------------------------------------------

FastApproximateAA::~FastApproximateAA()
{
}

// -----------------------------------------------------------------------------------------------------------------------------------

void FastApproximateAA::render(dw::vk::CommandBuffer::Ptr            cmd_buf,
                     DeferredShading*                                deferred_shading,
                     RayTracedAO*                                    ao,
                     RayTracedShadows*                               shadows,
                     RayTracedReflections*                           reflections,
                     DDGI*                                           ddgi,
                     GroundTruthPathTracer*                          ground_truth_path_tracer,
                     std::function<void(dw::vk::CommandBuffer::Ptr)> gui_callback)
{
    if(m_enabled == false)
        return;

    DW_SCOPED_SAMPLE("Tone Map", cmd_buf);

    auto vk_backend = m_backend.lock();

    VkClearValue clear_values[2];

    clear_values[0].color.float32[0] = 0.0f;
    clear_values[0].color.float32[1] = 0.0f;
    clear_values[0].color.float32[2] = 0.0f;
    clear_values[0].color.float32[3] = 1.0f;

    clear_values[1].color.float32[0] = 1.0f;
    clear_values[1].color.float32[1] = 1.0f;
    clear_values[1].color.float32[2] = 1.0f;
    clear_values[1].color.float32[3] = 1.0f;

    VkRenderPassBeginInfo info    = {};
    info.sType                    = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO;
    info.renderPass               = vk_backend->swapchain_render_pass()->handle();
    info.framebuffer              = vk_backend->swapchain_framebuffer()->handle();
    info.renderArea.extent.width  = m_width;
    info.renderArea.extent.height = m_height;
    info.clearValueCount          = 2;
    info.pClearValues             = &clear_values[0];

    vkCmdBeginRenderPass(cmd_buf->handle(), &info, VK_SUBPASS_CONTENTS_INLINE);

    VkViewport vp;

    vp.x        = 0.0f;
    vp.y        = (float)m_height;
    vp.width    = (float)m_width;
    vp.height   = -(float)m_height;
    vp.minDepth = 0.0f;
    vp.maxDepth = 1.0f;

    vkCmdSetViewport(cmd_buf->handle(), 0, 1, &vp);

    VkRect2D scissor_rect;

    scissor_rect.extent.width  = m_width;
    scissor_rect.extent.height = m_height;
    scissor_rect.offset.x      = 0;
    scissor_rect.offset.y      = 0;

    vkCmdSetScissor(cmd_buf->handle(), 0, 1, &scissor_rect);

    vkCmdBindPipeline(cmd_buf->handle(), VK_PIPELINE_BIND_POINT_GRAPHICS, m_pipeline->handle());

    VkDescriptorSet read_ds;

    if (m_common_resources->current_visualization_type == VISUALIZATION_TYPE_FINAL)
        read_ds = deferred_shading->output_ds()->handle();
    else if (m_common_resources->current_visualization_type == VISUALIZATION_TYPE_SHADOWS)
        read_ds = shadows->output_ds()->handle();
    else if (m_common_resources->current_visualization_type == VISUALIZATION_TYPE_AMBIENT_OCCLUSION)
        read_ds = ao->output_ds()->handle();
    else if (m_common_resources->current_visualization_type == VISUALIZATION_TYPE_REFLECTIONS)
        read_ds = reflections->output_ds()->handle();
    else if (m_common_resources->current_visualization_type == VISUALIZATION_TYPE_GLOBAL_ILLUIMINATION)
        read_ds = ddgi->output_ds()->handle();
    else
        read_ds = ground_truth_path_tracer->output_ds()->handle();

    VkDescriptorSet descriptor_sets[] = {
            read_ds
    };

    FastApproximateAAConstant push_constants;

    push_constants.AbsoluteLumaThreshold = m_absolute_luma_threshold;
    push_constants.ConsoleCharpness = m_console_charpness;
    push_constants.RelativeLumaThreshold = m_relative_luma_threshold;
    push_constants.DebugMode = (int) m_debug_mode;

    vkCmdPushConstants(cmd_buf->handle(), m_pipeline_layout->handle(), VK_SHADER_STAGE_FRAGMENT_BIT, 0, sizeof(FastApproximateAAConstant), &push_constants);

    vkCmdBindDescriptorSets(cmd_buf->handle(), VK_PIPELINE_BIND_POINT_GRAPHICS, m_pipeline_layout->handle(), 0, 1, descriptor_sets, 0, nullptr);

    vkCmdDraw(cmd_buf->handle(), 3, 1, 0, 0);

    if (gui_callback)
        gui_callback(cmd_buf);

    vkCmdEndRenderPass(cmd_buf->handle());
}

// -----------------------------------------------------------------------------------------------------------------------------------

void FastApproximateAA::gui()
{
    ImGui::PushID("GUI_FXAA");
    ImGui::Checkbox("Enabled", &m_enabled);
    ImGui::InputFloat("AbsoluteLumaThreshold", &m_absolute_luma_threshold);
    ImGui::InputFloat("RelativeLumaThreshold", &m_relative_luma_threshold);
    ImGui::InputFloat("ConsoleCharpness", &m_console_charpness);
    ImGui::Checkbox("Debug Mode", &m_debug_mode);
    ImGui::PopID();
}

// -----------------------------------------------------------------------------------------------------------------------------------

void FastApproximateAA::create_pipeline()
{
    auto vk_backend = m_backend.lock();

    dw::vk::PipelineLayout::Desc desc;

    desc.add_push_constant_range(VK_SHADER_STAGE_FRAGMENT_BIT, 0, sizeof(FastApproximateAAConstant));
    desc.add_descriptor_set_layout(m_common_resources->combined_sampler_ds_layout);

    m_pipeline_layout = dw::vk::PipelineLayout::create(vk_backend, desc);
    m_pipeline        = dw::vk::GraphicsPipeline::create_for_post_process(vk_backend, "shaders/triangle.vert.spv", "shaders/fast_approximate_aa.frag.spv", m_pipeline_layout, vk_backend->swapchain_render_pass());
}

// -----------------------------------------------------------------------------------------------------------------------------------